/**
 * Lambda Runtime API HTTP server using Effect HttpServer.
 *
 * This server emulates the AWS Lambda Runtime API that Docker containers
 * use to receive invocations and send responses.
 *
 * Each Lambda function gets its own server on an ephemeral port. The server
 * maintains a queue of pending invocations. When a container polls
 * /invocation/next, it blocks until an invocation is available.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

import { createServer } from "node:http"
import * as Headers from "@effect/platform/Headers"
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Effect, HashMap, Option, Queue, Ref, type Scope } from "effect"
import type {
  ExtensionEvent,
  ExtensionEventType,
  LambdaError,
  LambdaInitError,
  LambdaInvocation,
  LambdaResponse,
  RegisteredExtension,
} from "./types.js"

/**
 * State for a registered extension.
 */
interface ExtensionState {
  /** Extension info */
  extension: RegisteredExtension
  /** Queue of events for this extension */
  eventQueue: Queue.Queue<ExtensionEvent>
}

/**
 * Function metadata for extension registration responses.
 */
export interface FunctionMetadata {
  functionName: string
  functionVersion: string
  handler: string
}

/**
 * State for a Runtime API server session.
 * Supports multiple invocations with a queue-based model.
 */
export interface RuntimeApiState {
  /** Queue of pending invocations waiting to be fetched by the container */
  invocationQueue: Queue.Queue<LambdaInvocation>
  /** Queue for responses/errors from the container */
  responseQueue: Queue.Queue<LambdaResponse | LambdaError | LambdaInitError>
  /** Registered extensions by extension ID */
  extensions: Ref.Ref<HashMap.HashMap<string, ExtensionState>>
  /** Function metadata for extension registration */
  functionMetadata: FunctionMetadata
}

/**
 * Result from starting a Runtime API server.
 */
export interface RuntimeApiServer {
  /** The actual port the server is listening on */
  port: number
  /** The state containing the invocation and response queues */
  state: RuntimeApiState
}

/**
 * Create a new Runtime API state (queues only, no port).
 *
 * @param functionMetadata - Function metadata for extension registration responses
 */
export const makeRuntimeApiState = (functionMetadata: FunctionMetadata) =>
  Effect.gen(function* () {
    const invocationQueue = yield* Queue.unbounded<LambdaInvocation>()
    const responseQueue = yield* Queue.unbounded<
      LambdaResponse | LambdaError | LambdaInitError
    >()
    const extensions = yield* Ref.make(HashMap.empty<string, ExtensionState>())

    return {
      invocationQueue,
      responseQueue,
      extensions,
      functionMetadata,
    } satisfies RuntimeApiState
  })

/**
 * Default poll timeout - used when not overridden.
 *
 * ## Why containers can't stay warm indefinitely (like AWS Lambda does)
 *
 * AWS Lambda keeps containers warm for ~5-15 minutes between invocations.
 * Their Runtime API implementation can hold HTTP connections open indefinitely
 * because they control the entire infrastructure end-to-end.
 *
 * In local development, we're constrained by HTTP server limitations.
 * Node.js 24's default requestTimeout is 300 seconds (5 minutes), which is
 * sufficient for our 240 second poll timeout.
 *
 * Our solution: use a 240s timeout and return HTTP 503, which causes the RIC
 * to exit gracefully. The container will be automatically restarted on the next
 * invocation (~2 seconds for warm images).
 *
 * This is an inherent limitation of local Lambda emulation - AWS's purpose-built
 * infrastructure simply doesn't have the same timeout constraints.
 */
const DEFAULT_POLL_TIMEOUT_MS = 240_000 // 4 minutes

/**
 * Handle GET /2018-06-01/runtime/invocation/next
 * Polls for an invocation with a bounded timeout to handle idle containers gracefully.
 * This ensures that if no invocations arrive within the timeout, the container
 * exits cleanly rather than being killed by an HTTP timeout.
 *
 * When the timeout expires, we return a 503 Service Unavailable which signals
 * to the Lambda RIC that it should exit. The container will be restarted
 * automatically when the next invocation arrives.
 */
const handleInvocationNext = (state: RuntimeApiState, pollTimeoutMs: number) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Container polling for next invocation")

    const startTime = Date.now()

    // Poll with timeout instead of blocking indefinitely
    // This allows us to detect connection issues and keep the invocation in the queue
    let invocation: LambdaInvocation | null = null

    while (invocation === null) {
      // Check if we've exceeded the timeout
      if (Date.now() - startTime > pollTimeoutMs) {
        yield* Effect.logDebug(
          "Invocation poll timeout - returning 503 to trigger container exit",
        )
        // Return 503 Service Unavailable to signal the RIC to exit gracefully
        // This is expected behavior for idle containers in local development
        return HttpServerResponse.empty({
          status: 503,
          headers: Headers.fromInput({
            "Content-Type": "application/json",
          }),
        })
      }

      // Try to take from queue with a short timeout
      const result = yield* Queue.poll(state.invocationQueue)

      if (Option.isSome(result)) {
        invocation = result.value
      } else {
        // Queue is empty, wait a bit before retrying
        yield* Effect.sleep("100 millis")
      }
    }

    yield* Effect.logDebug(
      `Returning invocation ${invocation.requestId} to container`,
    )

    return yield* HttpServerResponse.json(invocation.event, {
      status: 200,
      headers: Headers.fromInput({
        "Lambda-Runtime-Aws-Request-Id": invocation.requestId,
        "Lambda-Runtime-Deadline-Ms": String(invocation.deadlineMs),
        "Lambda-Runtime-Invoked-Function-Arn": invocation.invokedFunctionArn,
        "Lambda-Runtime-Log-Group-Name": invocation.logGroupName,
        "Lambda-Runtime-Log-Stream-Name": invocation.logStreamName,
      }),
    })
  })

/**
 * Handle POST /2018-06-01/runtime/invocation/:requestId/response
 */
const handleInvocationResponse = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const requestId = params.requestId ?? ""
    const request = yield* HttpServerRequest.HttpServerRequest

    // Body might not be JSON, so gracefully handle parse errors
    const body = yield* Effect.orElseSucceed(request.json, () => null)

    const response: LambdaResponse = {
      requestId,
      body,
    }

    yield* Effect.logDebug(`Received response for ${requestId}`)
    yield* Queue.offer(state.responseQueue, response)

    return HttpServerResponse.empty({ status: 202 })
  })

/**
 * Handle POST /2018-06-01/runtime/invocation/:requestId/error
 */
const handleInvocationError = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const requestId = params.requestId ?? ""
    const request = yield* HttpServerRequest.HttpServerRequest

    // Body might not be JSON, so gracefully handle parse errors
    const errorBody = yield* Effect.orElseSucceed(
      request.json as Effect.Effect<
        { errorMessage?: string; stackTrace?: string[] },
        unknown
      >,
      (): { errorMessage?: string; stackTrace?: string[] } => ({}),
    )

    const errorTypeHeader = Headers.get(
      request.headers,
      "lambda-runtime-function-error-type",
    )
    const errorType = Option.getOrElse(errorTypeHeader, () => "Error")

    const error: LambdaError = {
      requestId,
      errorType: String(errorType),
      errorMessage: errorBody.errorMessage ?? "Unknown error",
      stackTrace: errorBody.stackTrace,
    }

    yield* Effect.logDebug(
      `Received error for ${requestId}: ${error.errorMessage}`,
    )
    yield* Queue.offer(state.responseQueue, error)

    return HttpServerResponse.empty({ status: 202 })
  })

/**
 * Handle POST /2018-06-01/runtime/init/error
 */
const handleInitError = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    // Body might not be JSON, so gracefully handle parse errors
    const errorBody = yield* Effect.orElseSucceed(
      request.json as Effect.Effect<
        { errorMessage?: string; stackTrace?: string[] },
        unknown
      >,
      (): { errorMessage?: string; stackTrace?: string[] } => ({}),
    )

    const errorTypeHeader = Headers.get(
      request.headers,
      "lambda-runtime-function-error-type",
    )
    const errorType = Option.getOrElse(errorTypeHeader, () => "InitError")

    const error: LambdaInitError = {
      errorType: String(errorType),
      errorMessage: errorBody.errorMessage ?? "Unknown init error",
      stackTrace: errorBody.stackTrace,
    }

    yield* Effect.logDebug(`Received init error: ${error.errorMessage}`)
    yield* Queue.offer(state.responseQueue, error)

    return HttpServerResponse.empty({ status: 202 })
  })

// ============================================================================
// Extensions API handlers
// @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html
// ============================================================================

/**
 * Handle POST /2020-01-01/extension/register
 * Extensions call this to register for lifecycle events.
 */
const handleExtensionRegister = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    // Get extension name from header (required)
    const extensionNameHeader = Headers.get(
      request.headers,
      "lambda-extension-name",
    )
    const extensionName = Option.getOrElse(
      extensionNameHeader,
      () => "unknown-extension",
    )

    // Parse request body for events to register for
    const body = yield* Effect.orElseSucceed(
      request.json as Effect.Effect<{ events?: ExtensionEventType[] }, unknown>,
      (): { events?: ExtensionEventType[] } => ({}),
    )
    const events: ExtensionEventType[] = body.events ?? ["INVOKE", "SHUTDOWN"]

    // Generate unique extension ID
    const extensionId = crypto.randomUUID()

    // Create event queue for this extension
    const eventQueue = yield* Queue.unbounded<ExtensionEvent>()

    const extensionState: ExtensionState = {
      extension: {
        extensionId,
        name: extensionName,
        events,
      },
      eventQueue,
    }

    // Register the extension
    yield* Ref.update(state.extensions, (exts) =>
      HashMap.set(exts, extensionId, extensionState),
    )

    yield* Effect.logDebug(
      `Extension registered: ${extensionName} (${extensionId}) for events: ${events.join(", ")}`,
    )

    return yield* HttpServerResponse.json(
      {
        functionName: state.functionMetadata.functionName,
        functionVersion: state.functionMetadata.functionVersion,
        handler: state.functionMetadata.handler,
      },
      {
        status: 200,
        headers: Headers.fromInput({
          "Lambda-Extension-Identifier": extensionId,
        }),
      },
    )
  })

/**
 * Handle GET /2020-01-01/extension/event/next
 * Extensions call this to poll for the next lifecycle event.
 */
const handleExtensionEventNext = (
  state: RuntimeApiState,
  pollTimeoutMs: number,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    // Get extension ID from header (required)
    const extensionIdHeader = Headers.get(
      request.headers,
      "lambda-extension-identifier",
    )
    const extensionId = Option.getOrElse(extensionIdHeader, () => "")

    if (!extensionId) {
      return HttpServerResponse.empty({
        status: 403,
        headers: Headers.fromInput({
          "Content-Type": "application/json",
        }),
      })
    }

    // Find the extension
    const extensions = yield* Ref.get(state.extensions)
    const extensionState = HashMap.get(extensions, extensionId)

    if (Option.isNone(extensionState)) {
      yield* Effect.logDebug(`Extension not found: ${extensionId}`)
      return HttpServerResponse.empty({
        status: 403,
        headers: Headers.fromInput({
          "Content-Type": "application/json",
        }),
      })
    }

    const { eventQueue, extension } = extensionState.value

    yield* Effect.logDebug(`Extension ${extension.name} polling for next event`)

    const startTime = Date.now()

    // Poll for the next event with timeout
    let event: ExtensionEvent | null = null

    while (event === null) {
      if (Date.now() - startTime > pollTimeoutMs) {
        yield* Effect.logDebug(
          "Extension event poll timeout - returning 503 to trigger exit",
        )
        return HttpServerResponse.empty({
          status: 503,
          headers: Headers.fromInput({
            "Content-Type": "application/json",
          }),
        })
      }

      const result = yield* Queue.poll(eventQueue)

      if (Option.isSome(result)) {
        event = result.value
      } else {
        yield* Effect.sleep("100 millis")
      }
    }

    yield* Effect.logDebug(
      `Returning ${event.eventType} event to extension ${extension.name}`,
    )

    return yield* HttpServerResponse.json(event, {
      status: 200,
      headers: Headers.fromInput({
        "Lambda-Extension-Event-Identifier": crypto.randomUUID(),
      }),
    })
  })

/**
 * Handle POST /2020-01-01/extension/init/error
 * Extensions call this to report initialization errors.
 */
const handleExtensionInitError = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    const extensionIdHeader = Headers.get(
      request.headers,
      "lambda-extension-identifier",
    )
    const extensionId = Option.getOrElse(extensionIdHeader, () => "unknown")

    const errorBody = yield* Effect.orElseSucceed(
      request.json as Effect.Effect<
        { errorMessage?: string; errorType?: string },
        unknown
      >,
      (): { errorMessage?: string; errorType?: string } => ({}),
    )

    yield* Effect.logDebug(
      `Extension ${extensionId} init error: ${errorBody.errorMessage ?? "unknown"}`,
    )

    // Report the error through the response queue
    const initError: LambdaInitError = {
      errorType: errorBody.errorType ?? "Extension.InitError",
      errorMessage: errorBody.errorMessage ?? "Extension initialization failed",
    }
    yield* Queue.offer(state.responseQueue, initError)

    return HttpServerResponse.empty({ status: 202 })
  })

/**
 * Handle POST /2020-01-01/extension/exit/error
 * Extensions call this to report errors before exiting.
 */
const handleExtensionExitError = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    const extensionIdHeader = Headers.get(
      request.headers,
      "lambda-extension-identifier",
    )
    const extensionId = Option.getOrElse(extensionIdHeader, () => "unknown")

    const errorBody = yield* Effect.orElseSucceed(
      request.json as Effect.Effect<
        { errorMessage?: string; errorType?: string },
        unknown
      >,
      (): { errorMessage?: string; errorType?: string } => ({}),
    )

    yield* Effect.logDebug(
      `Extension ${extensionId} exit error: ${errorBody.errorMessage ?? "unknown"}`,
    )

    // Just acknowledge - extension is exiting anyway
    return HttpServerResponse.empty({ status: 202 })
  })

// ============================================================================
// Router
// ============================================================================

/**
 * Create the Runtime API router for a given state.
 */
const makeRuntimeApiRouter = (state: RuntimeApiState, pollTimeoutMs: number) =>
  HttpRouter.empty.pipe(
    // Runtime API (2018-06-01)
    HttpRouter.get(
      "/2018-06-01/runtime/invocation/next",
      handleInvocationNext(state, pollTimeoutMs),
    ),
    HttpRouter.post(
      "/2018-06-01/runtime/invocation/:requestId/response",
      handleInvocationResponse(state),
    ),
    HttpRouter.post(
      "/2018-06-01/runtime/invocation/:requestId/error",
      handleInvocationError(state),
    ),
    HttpRouter.post("/2018-06-01/runtime/init/error", handleInitError(state)),
    // Extensions API (2020-01-01)
    HttpRouter.post(
      "/2020-01-01/extension/register",
      handleExtensionRegister(state),
    ),
    HttpRouter.get(
      "/2020-01-01/extension/event/next",
      handleExtensionEventNext(state, pollTimeoutMs),
    ),
    HttpRouter.post(
      "/2020-01-01/extension/init/error",
      handleExtensionInitError(state),
    ),
    HttpRouter.post(
      "/2020-01-01/extension/exit/error",
      handleExtensionExitError(),
    ),
  )

/**
 * Options for starting a Runtime API server.
 */
export interface RuntimeApiServerOptions {
  /** How long to wait for an invocation before returning 503 */
  pollTimeoutMs?: number
  /** Function metadata for extension registration */
  functionMetadata?: FunctionMetadata
}

const DEFAULT_FUNCTION_METADATA: FunctionMetadata = {
  functionName: "local-function",
  functionVersion: "$LATEST",
  handler: "index.handler",
}

/**
 * Start a Runtime API server on an ephemeral port.
 * Returns the actual port and state for this server instance.
 *
 * The server is scoped - it will be stopped when the scope closes.
 *
 * @param options - Server configuration options
 */
export const startRuntimeApiServer = (
  options: RuntimeApiServerOptions = {},
): Effect.Effect<RuntimeApiServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const functionMetadata =
      options.functionMetadata ?? DEFAULT_FUNCTION_METADATA

    // Create state (queues) for this server
    const state = yield* makeRuntimeApiState(functionMetadata)

    // Create router for this state
    const router = makeRuntimeApiRouter(state, pollTimeoutMs)

    // Create HTTP server on ephemeral port (port: 0)
    const server = yield* NodeHttpServer.make(() => createServer(), {
      port: 0,
      host: "0.0.0.0",
    }).pipe(Effect.orDie)

    // Start serving the router
    yield* server.serve(router)

    // Get the actual assigned port
    const address = server.address
    if (address._tag !== "TcpAddress") {
      // This should never happen since we're using TCP
      throw new Error("Expected TCP address")
    }

    yield* Effect.logDebug(
      `RuntimeAPI server listening on port ${address.port}`,
    )

    return {
      port: address.port,
      state,
    } satisfies RuntimeApiServer
  })

/**
 * Queue an invocation for the container to process.
 */
export const queueInvocation = (
  state: RuntimeApiState,
  invocation: LambdaInvocation,
): Effect.Effect<void> => Queue.offer(state.invocationQueue, invocation)

/**
 * Wait for the response to a specific invocation.
 */
export const waitForResponse = (
  state: RuntimeApiState,
): Effect.Effect<LambdaResponse | LambdaError | LambdaInitError> =>
  Queue.take(state.responseQueue)

/**
 * Notify all registered extensions about an invocation.
 * This sends an INVOKE event to all extensions that registered for it.
 */
export const notifyExtensionsInvoke = (
  state: RuntimeApiState,
  invocation: LambdaInvocation,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const extensions = yield* Ref.get(state.extensions)

    const invokeEvent: ExtensionEvent = {
      eventType: "INVOKE",
      deadlineMs: invocation.deadlineMs,
      requestId: invocation.requestId,
      invokedFunctionArn: invocation.invokedFunctionArn,
    }

    // Send INVOKE event to all extensions that registered for it
    for (const [, extState] of extensions) {
      if (extState.extension.events.includes("INVOKE")) {
        yield* Queue.offer(extState.eventQueue, invokeEvent)
        yield* Effect.logDebug(
          `Sent INVOKE event to extension ${extState.extension.name}`,
        )
      }
    }
  })

/**
 * Notify all registered extensions about shutdown.
 * This sends a SHUTDOWN event to all extensions that registered for it.
 */
export const notifyExtensionsShutdown = (
  state: RuntimeApiState,
  reason: "SPINDOWN" | "TIMEOUT" | "FAILURE" = "SPINDOWN",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const extensions = yield* Ref.get(state.extensions)

    const shutdownEvent: ExtensionEvent = {
      eventType: "SHUTDOWN",
      shutdownReason: reason,
      deadlineMs: Date.now() + 2000, // 2 second deadline for shutdown
    }

    // Send SHUTDOWN event to all extensions that registered for it
    for (const [, extState] of extensions) {
      if (extState.extension.events.includes("SHUTDOWN")) {
        yield* Queue.offer(extState.eventQueue, shutdownEvent)
        yield* Effect.logDebug(
          `Sent SHUTDOWN event to extension ${extState.extension.name}`,
        )
      }
    }
  })
