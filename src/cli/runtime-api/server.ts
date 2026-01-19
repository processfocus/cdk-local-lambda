/**
 * Lambda Runtime API HTTP server using Bun's native HTTP server.
 *
 * This server emulates the AWS Lambda Runtime API that Docker containers
 * use to receive invocations and send responses.
 *
 * The server maintains a queue of pending invocations. When a container
 * polls /invocation/next, it blocks until an invocation is available.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

import { Effect, Queue, type Scope } from "effect"
import type {
  LambdaError,
  LambdaInitError,
  LambdaInvocation,
  LambdaResponse,
} from "./types.js"

type BunServer = ReturnType<typeof Bun.serve>

/**
 * State for a Runtime API server session.
 * Supports multiple invocations with a queue-based model.
 */
export interface RuntimeApiState {
  /** Queue of pending invocations waiting to be fetched by the container */
  invocationQueue: Queue.Queue<LambdaInvocation>
  /** Queue for responses/errors from the container */
  responseQueue: Queue.Queue<LambdaResponse | LambdaError | LambdaInitError>
  /** The port the server is listening on */
  port: number
}

/**
 * Create a new Runtime API state.
 */
export const makeRuntimeApiState = (port: number) =>
  Effect.gen(function* () {
    const invocationQueue = yield* Queue.unbounded<LambdaInvocation>()
    const responseQueue = yield* Queue.unbounded<
      LambdaResponse | LambdaError | LambdaInitError
    >()

    return {
      invocationQueue,
      responseQueue,
      port,
    } satisfies RuntimeApiState
  })

/**
 * Parse route from request path.
 */
const parseRoute = (
  path: string,
): {
  type:
    | "invocation-next"
    | "invocation-response"
    | "invocation-error"
    | "init-error"
    | "unknown"
  requestId?: string
} => {
  const invocationNext = /^\/2018-06-01\/runtime\/invocation\/next\/?$/.exec(
    path,
  )
  if (invocationNext) {
    return { type: "invocation-next" }
  }

  const invocationResponse =
    /^\/2018-06-01\/runtime\/invocation\/([^/]+)\/response\/?$/.exec(path)
  if (invocationResponse) {
    return { type: "invocation-response", requestId: invocationResponse[1] }
  }

  const invocationError =
    /^\/2018-06-01\/runtime\/invocation\/([^/]+)\/error\/?$/.exec(path)
  if (invocationError) {
    return { type: "invocation-error", requestId: invocationError[1] }
  }

  const initError = /^\/2018-06-01\/runtime\/init\/error\/?$/.exec(path)
  if (initError) {
    return { type: "init-error" }
  }

  return { type: "unknown" }
}

/**
 * Handle GET /2018-06-01/runtime/invocation/next
 * Blocks until an invocation is available in the queue.
 */
const handleInvocationNext = async (
  state: RuntimeApiState,
): Promise<Response> => {
  console.log("[RuntimeAPI] Container polling for next invocation...")

  // Block until an invocation is available
  const invocation = await Effect.runPromise(Queue.take(state.invocationQueue))

  console.log(
    `[RuntimeAPI] Returning invocation ${invocation.requestId} to container`,
  )

  return new Response(JSON.stringify(invocation.event), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Lambda-Runtime-Aws-Request-Id": invocation.requestId,
      "Lambda-Runtime-Deadline-Ms": String(invocation.deadlineMs),
      "Lambda-Runtime-Invoked-Function-Arn": invocation.invokedFunctionArn,
      "Lambda-Runtime-Log-Group-Name": invocation.logGroupName,
      "Lambda-Runtime-Log-Stream-Name": invocation.logStreamName,
    },
  })
}

/**
 * Handle POST /2018-06-01/runtime/invocation/{requestId}/response
 */
const handleInvocationResponse = async (
  state: RuntimeApiState,
  requestId: string,
  request: Request,
): Promise<Response> => {
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    // Body might not be JSON
  }

  const response: LambdaResponse = {
    requestId,
    body,
  }

  console.log(`[RuntimeAPI] Received response for ${requestId}`)
  Effect.runSync(Queue.offer(state.responseQueue, response))

  return new Response(null, { status: 202 })
}

/**
 * Handle POST /2018-06-01/runtime/invocation/{requestId}/error
 */
const handleInvocationError = async (
  state: RuntimeApiState,
  requestId: string,
  request: Request,
): Promise<Response> => {
  let errorBody: { errorMessage?: string; stackTrace?: string[] } = {}
  try {
    errorBody = (await request.json()) as typeof errorBody
  } catch {
    // Body might not be JSON
  }

  const errorType =
    request.headers.get("lambda-runtime-function-error-type") ?? "Error"

  const error: LambdaError = {
    requestId,
    errorType: String(errorType),
    errorMessage: errorBody.errorMessage ?? "Unknown error",
    stackTrace: errorBody.stackTrace,
  }

  console.log(
    `[RuntimeAPI] Received error for ${requestId}: ${error.errorMessage}`,
  )
  Effect.runSync(Queue.offer(state.responseQueue, error))

  return new Response(null, { status: 202 })
}

/**
 * Handle POST /2018-06-01/runtime/init/error
 */
const handleInitError = async (
  state: RuntimeApiState,
  request: Request,
): Promise<Response> => {
  let errorBody: { errorMessage?: string; stackTrace?: string[] } = {}
  try {
    errorBody = (await request.json()) as typeof errorBody
  } catch {
    // Body might not be JSON
  }

  const errorType =
    request.headers.get("lambda-runtime-function-error-type") ?? "InitError"

  const error: LambdaInitError = {
    errorType: String(errorType),
    errorMessage: errorBody.errorMessage ?? "Unknown init error",
    stackTrace: errorBody.stackTrace,
  }

  console.log(`[RuntimeAPI] Received init error: ${error.errorMessage}`)
  Effect.runSync(Queue.offer(state.responseQueue, error))

  return new Response(null, { status: 202 })
}

/**
 * Create and start the Runtime API server.
 * Returns the server instance which can be stopped later.
 */
export const createRuntimeApiServer = (state: RuntimeApiState): BunServer => {
  const server = Bun.serve({
    port: state.port,
    hostname: "0.0.0.0",
    // Long idle timeout for long-polling /invocation/next requests
    idleTimeout: 255, // Maximum allowed by Bun (4.25 minutes)
    fetch: async (request) => {
      const url = new URL(request.url)
      const route = parseRoute(url.pathname)

      // Don't log polling requests to reduce noise
      if (route.type !== "invocation-next") {
        console.log(
          `[RuntimeAPI] ${request.method} ${url.pathname} -> ${route.type}`,
        )
      }

      switch (route.type) {
        case "invocation-next":
          return handleInvocationNext(state)
        case "invocation-response":
          return handleInvocationResponse(state, route.requestId!, request)
        case "invocation-error":
          return handleInvocationError(state, route.requestId!, request)
        case "init-error":
          return handleInitError(state, request)
        default:
          console.log(`[RuntimeAPI] Unknown route: ${url.pathname}`)
          return new Response("Not Found", { status: 404 })
      }
    },
  })

  console.log(
    `[RuntimeAPI] Server listening on ${server.hostname}:${server.port}`,
  )

  return server
}

/**
 * Create a Runtime API server that listens on the specified port.
 * Returns a scoped effect that keeps the server running until the scope closes.
 */
export const startRuntimeApiServer = (
  state: RuntimeApiState,
): Effect.Effect<BunServer, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => createRuntimeApiServer(state)),
    (server) =>
      Effect.sync(() => {
        console.log(`[RuntimeAPI] Stopping server on port ${state.port}`)
        server.stop()
      }),
  )

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
