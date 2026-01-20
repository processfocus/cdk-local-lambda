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

import * as Headers from "@effect/platform/Headers"
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Effect, Option, Queue, type Scope } from "effect"
import type {
  LambdaError,
  LambdaInitError,
  LambdaInvocation,
  LambdaResponse,
} from "./types.js"

/**
 * State for a Runtime API server session.
 * Supports multiple invocations with a queue-based model.
 */
export interface RuntimeApiState {
  /** Queue of pending invocations waiting to be fetched by the container */
  invocationQueue: Queue.Queue<LambdaInvocation>
  /** Queue for responses/errors from the container */
  responseQueue: Queue.Queue<LambdaResponse | LambdaError | LambdaInitError>
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
 */
export const makeRuntimeApiState = () =>
  Effect.gen(function* () {
    const invocationQueue = yield* Queue.unbounded<LambdaInvocation>()
    const responseQueue = yield* Queue.unbounded<
      LambdaResponse | LambdaError | LambdaInitError
    >()

    return {
      invocationQueue,
      responseQueue,
    } satisfies RuntimeApiState
  })

/**
 * Handle GET /2018-06-01/runtime/invocation/next
 * Blocks until an invocation is available in the queue.
 */
const handleInvocationNext = (state: RuntimeApiState) =>
  Effect.gen(function* () {
    console.log("[RuntimeAPI] Container polling for next invocation...")

    // Block until an invocation is available
    const invocation = yield* Queue.take(state.invocationQueue)

    console.log(
      `[RuntimeAPI] Returning invocation ${invocation.requestId} to container`,
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

    console.log(`[RuntimeAPI] Received response for ${requestId}`)
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

    console.log(
      `[RuntimeAPI] Received error for ${requestId}: ${error.errorMessage}`,
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

    console.log(`[RuntimeAPI] Received init error: ${error.errorMessage}`)
    yield* Queue.offer(state.responseQueue, error)

    return HttpServerResponse.empty({ status: 202 })
  })

/**
 * Create the Runtime API router for a given state.
 */
const makeRuntimeApiRouter = (state: RuntimeApiState) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/2018-06-01/runtime/invocation/next",
      handleInvocationNext(state),
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
  )

/**
 * Start a Runtime API server on an ephemeral port.
 * Returns the actual port and state for this server instance.
 *
 * The server is scoped - it will be stopped when the scope closes.
 */
export const startRuntimeApiServer = (): Effect.Effect<
  RuntimeApiServer,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // Create state (queues) for this server
    const state = yield* makeRuntimeApiState()

    // Create router for this state
    const router = makeRuntimeApiRouter(state)

    // Create HTTP server on ephemeral port (port: 0)
    const server = yield* BunHttpServer.make({
      port: 0,
      hostname: "0.0.0.0",
      idleTimeout: 255, // Max allowed by Bun (4.25 minutes) for long-polling
    })

    // Start serving the router
    yield* server.serve(router)

    // Get the actual assigned port
    const address = server.address
    if (address._tag !== "TcpAddress") {
      // This should never happen since we're using TCP
      throw new Error("Expected TCP address")
    }

    console.log(`[RuntimeAPI] Server listening on port ${address.port}`)

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
