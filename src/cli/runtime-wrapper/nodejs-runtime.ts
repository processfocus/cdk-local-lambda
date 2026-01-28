/**
 * Node.js runtime wrapper that emulates the Lambda Runtime environment.
 *
 * This script does what the Lambda runtime does inside a container:
 * 1. Polls our local Runtime API for invocations (GET /invocation/next)
 * 2. Loads and invokes the user's handler via import()
 * 3. Posts responses back (POST /invocation/{requestId}/response)
 *
 * Environment variables:
 * - AWS_LAMBDA_RUNTIME_API: The host:port of our local Runtime API server
 * - _HANDLER: The handler path in format "path/to/file.handlerName"
 * - LAMBDA_TASK_ROOT: The project root directory for resolving handler modules
 *
 * This script is spawned by the daemon for each Node.js Lambda function.
 */

import * as path from "node:path"
import type { Context } from "aws-lambda"

// Runtime API base URL from environment
const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API
if (!RUNTIME_API) {
  console.error("AWS_LAMBDA_RUNTIME_API not set")
  process.exit(1)
}

// Handler path from environment (e.g., "functions/greeter/handler.handler")
const HANDLER = process.env._HANDLER
if (!HANDLER) {
  console.error("_HANDLER not set")
  process.exit(1)
}

// Project root for resolving handler modules
const PROJECT_ROOT = process.env.LAMBDA_TASK_ROOT ?? process.cwd()

const RUNTIME_API_BASE = `http://${RUNTIME_API}`

// Current request ID for logging context (set during invocation)
let currentRequestId: string | null = null

/**
 * Log an error in Lambda log format so it gets the proper invocation prefix.
 * Format: TIMESTAMP\tREQUEST_ID\tLEVEL\tMESSAGE
 */
function lambdaError(level: string, message: string): void {
  const timestamp = new Date().toISOString()
  const requestId = currentRequestId ?? "00000000-0000-0000-0000-000000000000"
  console.error(`${timestamp}\t${requestId}\t${level}\t${message}`)
}

/**
 * Parse handler path into module path and export name.
 * Handler format: "path/to/module.exportName"
 * Example: "functions/greeter/handler.handler" -> { modulePath: "functions/greeter/handler", exportName: "handler" }
 */
function parseHandler(handlerPath: string): {
  modulePath: string
  exportName: string
} {
  const lastDot = handlerPath.lastIndexOf(".")
  if (lastDot === -1) {
    throw new Error(
      `Invalid handler format: "${handlerPath}". Expected "path/to/module.exportName"`,
    )
  }
  return {
    modulePath: handlerPath.substring(0, lastDot),
    exportName: handlerPath.substring(lastDot + 1),
  }
}

/**
 * Resolve and load the handler function.
 * Tries common extensions: .ts, .js, .mjs, .cjs (Bun handles all natively)
 */
async function loadHandler(
  handlerPath: string,
  projectRoot: string,
): Promise<(event: unknown, context: Context) => Promise<unknown>> {
  const { modulePath, exportName } = parseHandler(handlerPath)

  // Extensions to try (Bun supports all natively)
  const extensions = [".ts", ".js", ".mjs", ".cjs", ""]

  let loadedModule: Record<string, unknown> | undefined
  let resolvedPath: string | undefined

  for (const ext of extensions) {
    const fullPath = path.resolve(projectRoot, modulePath + ext)
    try {
      loadedModule = (await import(fullPath)) as Record<string, unknown>
      resolvedPath = fullPath
      break
    } catch {
      // Try next extension
    }
  }

  if (!loadedModule || !resolvedPath) {
    throw new Error(
      `Could not load handler module: "${modulePath}" (tried extensions: ${extensions.join(", ")})`,
    )
  }

  const handler = loadedModule[exportName]
  if (typeof handler !== "function") {
    throw new Error(
      `Handler "${exportName}" is not a function (got ${typeof handler})`,
    )
  }

  return handler as (event: unknown, context: Context) => Promise<unknown>
}

/**
 * Get next invocation from Runtime API.
 * This blocks until an invocation is available.
 *
 * Returns null if the server returned 503 (poll timeout), signaling we should retry.
 * This is expected behavior - the server times out idle connections to work within
 * HTTP server limitations, but native workers can just reconnect and keep polling.
 */
async function getNextInvocation(): Promise<{
  event: unknown
  context: Context
  requestId: string
} | null> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/2018-06-01/runtime/invocation/next`,
  )

  // 503 means the server's poll timeout expired - this is expected behavior
  // for idle connections. Native workers should just retry polling.
  if (response.status === 503) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to get next invocation: ${response.status}`)
  }

  const event = await response.json()
  const requestId = response.headers.get("Lambda-Runtime-Aws-Request-Id") ?? ""
  const deadlineMs = response.headers.get("Lambda-Runtime-Deadline-Ms") ?? "0"
  const invokedFunctionArn =
    response.headers.get("Lambda-Runtime-Invoked-Function-Arn") ?? ""
  const logGroupName =
    response.headers.get("Lambda-Runtime-Log-Group-Name") ?? ""
  const logStreamName =
    response.headers.get("Lambda-Runtime-Log-Stream-Name") ?? ""

  // Extract function name and version from ARN
  // ARN format: arn:aws:lambda:region:account:function:name:version
  const arnParts = invokedFunctionArn.split(":")
  const functionName = arnParts[6] ?? ""
  const functionVersion = arnParts[7] ?? "$LATEST"

  // Build Lambda context object
  const context: Context = {
    functionName,
    functionVersion,
    invokedFunctionArn,
    memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "128",
    awsRequestId: requestId,
    logGroupName,
    logStreamName,
    getRemainingTimeInMillis: () =>
      Math.max(0, Number(deadlineMs) - Date.now()),
    // These are not used in local execution but required by the type
    callbackWaitsForEmptyEventLoop: true,
    identity: undefined,
    clientContext: undefined,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  }

  return { event, context, requestId }
}

/**
 * Post successful response to Runtime API.
 */
async function postResponse(requestId: string, result: unknown): Promise<void> {
  const response = await fetch(
    `${RUNTIME_API_BASE}/2018-06-01/runtime/invocation/${requestId}/response`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    },
  )

  if (!response.ok) {
    lambdaError("ERROR", `Failed to post response: ${response.status}`)
  }
}

/**
 * Post error to Runtime API.
 */
async function postError(requestId: string, error: Error): Promise<void> {
  const errorPayload = {
    errorType: error.name ?? "Error",
    errorMessage: error.message ?? String(error),
    stackTrace: error.stack?.split("\n") ?? [],
  }

  const response = await fetch(
    `${RUNTIME_API_BASE}/2018-06-01/runtime/invocation/${requestId}/error`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lambda-Runtime-Function-Error-Type": errorPayload.errorType,
      },
      body: JSON.stringify(errorPayload),
    },
  )

  if (!response.ok) {
    lambdaError("ERROR", `Failed to post error: ${response.status}`)
  }
}

/**
 * Post init error to Runtime API.
 */
async function postInitError(error: Error): Promise<void> {
  const errorPayload = {
    errorType: error.name ?? "InitError",
    errorMessage: error.message ?? String(error),
    stackTrace: error.stack?.split("\n") ?? [],
  }

  try {
    await fetch(`${RUNTIME_API_BASE}/2018-06-01/runtime/init/error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lambda-Runtime-Function-Error-Type": errorPayload.errorType,
      },
      body: JSON.stringify(errorPayload),
    })
  } catch {
    // Ignore - we're already in an error state
  }
}

/**
 * Main runtime loop.
 */
async function main(): Promise<void> {
  // Load handler once at startup
  // Note: bun --watch automatically tracks dynamic imports and restarts when they change
  let handler: (event: unknown, context: Context) => Promise<unknown>
  try {
    handler = await loadHandler(HANDLER!, PROJECT_ROOT)
  } catch (error) {
    console.error(`Failed to load handler: ${error}`)
    await postInitError(
      error instanceof Error ? error : new Error(String(error)),
    )
    process.exit(1)
  }

  // Main invocation loop
  while (true) {
    try {
      // Get next invocation (blocks until available)
      const invocation = await getNextInvocation()

      // null means 503 timeout - server wants us to reconnect and keep polling
      if (invocation === null) {
        // Small delay before reconnecting to avoid tight loop
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }

      const { event, context, requestId } = invocation
      currentRequestId = requestId

      try {
        // Invoke handler
        const result = await handler(event, context)

        // Post response
        await postResponse(requestId, result)
      } catch (error) {
        lambdaError("ERROR", `Handler error: ${error}`)
        await postError(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        )
      } finally {
        currentRequestId = null
      }
    } catch (error) {
      // Error getting next invocation - this is fatal, exit and let daemon restart
      console.error(`Fatal error in invocation loop: ${error}`)
      process.exit(1)
    }
  }
}

// Run the main loop
main().catch((error) => {
  console.error(`Unhandled error: ${error}`)
  process.exit(1)
})
