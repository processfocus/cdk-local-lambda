/**
 * Lambda Custom Runtime implementation for the Docker bridge.
 *
 * This implements the Lambda Runtime API to:
 * 1. Fetch invocations from the runtime API
 * 2. Call the bridge handler
 * 3. Post responses back to the runtime API
 */

import { handler as bridgeHandler } from "../bridge/handler.js"
import type { Context } from "aws-lambda"

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API
const HANDLER = process.env._HANDLER || "index.handler"

if (!RUNTIME_API) {
  console.error("[Runtime] AWS_LAMBDA_RUNTIME_API not set")
  process.exit(1)
}

const RUNTIME_BASE = `http://${RUNTIME_API}/2018-06-01/runtime`

interface RuntimeHeaders {
  "lambda-runtime-aws-request-id": string
  "lambda-runtime-deadline-ms": string
  "lambda-runtime-invoked-function-arn": string
  "lambda-runtime-trace-id"?: string
  "lambda-runtime-client-context"?: string
  "lambda-runtime-cognito-identity"?: string
}

async function getNextInvocation(): Promise<{
  event: unknown
  context: Context
}> {
  const response = await fetch(`${RUNTIME_BASE}/invocation/next`)

  if (!response.ok) {
    throw new Error(`Failed to get next invocation: ${response.status}`)
  }

  const headers = Object.fromEntries(
    response.headers.entries(),
  ) as unknown as RuntimeHeaders
  const event = await response.json()

  const requestId = headers["lambda-runtime-aws-request-id"]
  const deadlineMs = parseInt(headers["lambda-runtime-deadline-ms"], 10)
  const invokedFunctionArn = headers["lambda-runtime-invoked-function-arn"]
  const traceId = headers["lambda-runtime-trace-id"]

  // Set trace ID environment variable for X-Ray
  if (traceId) {
    process.env._X_AMZN_TRACE_ID = traceId
  }

  const context: Context = {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || "unknown",
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || "$LATEST",
    invokedFunctionArn,
    memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || "256",
    awsRequestId: requestId,
    logGroupName:
      process.env.AWS_LAMBDA_LOG_GROUP_NAME || "/aws/lambda/unknown",
    logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME || "unknown",
    getRemainingTimeInMillis: () => deadlineMs - Date.now(),
    callbackWaitsForEmptyEventLoop: true,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  }

  return { event, context }
}

async function postResponse(
  requestId: string,
  response: unknown,
): Promise<void> {
  const res = await fetch(`${RUNTIME_BASE}/invocation/${requestId}/response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  })

  if (!res.ok) {
    throw new Error(`Failed to post response: ${res.status}`)
  }
}

async function postError(requestId: string, error: Error): Promise<void> {
  const errorPayload = {
    errorType: error.name || "Error",
    errorMessage: error.message,
    stackTrace: error.stack?.split("\n") || [],
  }

  const res = await fetch(`${RUNTIME_BASE}/invocation/${requestId}/error`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lambda-Runtime-Function-Error-Type": "Unhandled",
    },
    body: JSON.stringify(errorPayload),
  })

  if (!res.ok) {
    console.error(`[Runtime] Failed to post error: ${res.status}`)
  }
}

async function postInitError(error: Error): Promise<void> {
  const errorPayload = {
    errorType: error.name || "Error",
    errorMessage: error.message,
    stackTrace: error.stack?.split("\n") || [],
  }

  const res = await fetch(`${RUNTIME_BASE}/init/error`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lambda-Runtime-Function-Error-Type": "Unhandled",
    },
    body: JSON.stringify(errorPayload),
  })

  if (!res.ok) {
    console.error(`[Runtime] Failed to post init error: ${res.status}`)
  }
}

async function main() {
  console.log("[Runtime] Starting Lambda custom runtime")
  console.log(`[Runtime] Handler: ${HANDLER}`)
  console.log(`[Runtime] Function: ${process.env.AWS_LAMBDA_FUNCTION_NAME}`)

  // Process invocations in a loop
  while (true) {
    let requestId: string | undefined

    try {
      // Get next invocation
      const { event, context } = await getNextInvocation()
      requestId = context.awsRequestId

      console.log(`[Runtime] Processing invocation ${requestId}`)

      // Call the bridge handler
      const result = await bridgeHandler(event, context)

      // Post response
      await postResponse(requestId, result)
      console.log(`[Runtime] Response sent for ${requestId}`)
    } catch (error) {
      console.error(`[Runtime] Error:`, error)

      if (requestId) {
        await postError(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        )
      } else {
        await postInitError(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
  }
}

main().catch((error) => {
  console.error("[Runtime] Fatal error:", error)
  postInitError(
    error instanceof Error ? error : new Error(String(error)),
  ).finally(() => process.exit(1))
})
