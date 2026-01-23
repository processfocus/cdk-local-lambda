/**
 * Effect-based AppSync Events client for the daemon.
 *
 * Wraps the existing AppSync client with Effect primitives for better
 * error handling and resource management.
 */

import { Sha256 } from "@aws-crypto/sha256-js"
import { defaultProvider } from "@aws-sdk/credential-provider-node"
import { HttpRequest } from "@aws-sdk/protocol-http"
import { SignatureV4 } from "@aws-sdk/signature-v4"
import { Effect, Stream } from "effect"
import WebSocket from "ws"
import type { InvocationMessage, ResponseMessage } from "../../shared/types.js"

/**
 * Configuration for the Effect AppSync client.
 */
export interface AppSyncClientConfig {
  httpEndpoint: string
  realtimeEndpoint: string
  region?: string
}

/**
 * Create an Effect-based AppSync Events client.
 */
export const makeAppSyncClient = (config: AppSyncClientConfig) => {
  // Extract region from endpoint URL
  const match = config.httpEndpoint.match(/\.([a-z0-9-]+)\.amazonaws\.com/)
  const region =
    config.region ?? match?.[1] ?? process.env.AWS_REGION ?? "us-east-1"

  /**
   * Sign a request with AWS SigV4.
   */
  const signRequest = (request: HttpRequest) =>
    Effect.tryPromise({
      try: async () => {
        const signer = new SignatureV4({
          credentials: defaultProvider(),
          region,
          service: "appsync",
          sha256: Sha256,
        })
        return await signer.sign(request)
      },
      catch: (error) => new Error(`Failed to sign request: ${String(error)}`),
    })

  /**
   * Create authorization headers for subscribe operation.
   */
  const createSubscribeAuthorization = (channel: string) =>
    Effect.gen(function* () {
      const httpUrl = new URL(config.httpEndpoint)
      const payload = JSON.stringify({ channel })

      const request = new HttpRequest({
        method: "POST",
        protocol: "https:",
        hostname: httpUrl.hostname,
        path: "/event",
        headers: {
          accept: "application/json, text/javascript",
          "content-encoding": "amz-1.0",
          "content-type": "application/json; charset=UTF-8",
          host: httpUrl.hostname,
        },
        body: payload,
      })

      const signedRequest = yield* signRequest(request)

      const auth: Record<string, string> = {
        accept: "application/json, text/javascript",
        "content-encoding": "amz-1.0",
        "content-type": "application/json; charset=UTF-8",
        host: httpUrl.hostname,
        "x-amz-date": signedRequest.headers["x-amz-date"],
        "x-amz-content-sha256": signedRequest.headers["x-amz-content-sha256"],
        Authorization: signedRequest.headers["authorization"],
      }

      if (signedRequest.headers["x-amz-security-token"]) {
        auth["x-amz-security-token"] =
          signedRequest.headers["x-amz-security-token"]
      }

      return auth
    })

  /**
   * Build signed WebSocket connection info.
   */
  const buildSignedWebSocketConnection = Effect.gen(function* () {
    const realtimeUrl = new URL(config.realtimeEndpoint)
    realtimeUrl.pathname = "/event/realtime"
    const httpUrl = new URL(config.httpEndpoint)

    const request = new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname: httpUrl.hostname,
      path: "/event",
      headers: {
        accept: "application/json, text/javascript",
        "content-encoding": "amz-1.0",
        "content-type": "application/json; charset=UTF-8",
        host: httpUrl.hostname,
      },
      body: "{}",
    })

    const signedRequest = yield* signRequest(request)

    const headerPayload: Record<string, string> = {
      accept: "application/json, text/javascript",
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=UTF-8",
      host: httpUrl.hostname,
      "x-amz-date": signedRequest.headers["x-amz-date"],
      "x-amz-content-sha256": signedRequest.headers["x-amz-content-sha256"],
      Authorization: signedRequest.headers["authorization"],
    }

    if (signedRequest.headers["x-amz-security-token"]) {
      headerPayload["x-amz-security-token"] =
        signedRequest.headers["x-amz-security-token"]
    }

    const encodedHeader = Buffer.from(JSON.stringify(headerPayload))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

    const authSubprotocol = `header-${encodedHeader}`

    return {
      url: realtimeUrl.toString(),
      subprotocols: ["aws-appsync-event-ws", authSubprotocol] as const,
    }
  })

  /**
   * Publish a message to a channel.
   */
  const publish = (channel: string, message: unknown) =>
    Effect.gen(function* () {
      const url = new URL(config.httpEndpoint)
      const body = JSON.stringify({
        channel,
        events: [JSON.stringify(message)],
      })

      const path = url.pathname.endsWith("/event") ? url.pathname : "/event"

      const request = new HttpRequest({
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        path,
        headers: {
          "Content-Type": "application/json",
          host: url.hostname,
        },
        body,
      })

      const signedRequest = yield* signRequest(request)

      const publishUrl = `${url.protocol}//${url.hostname}${path}`
      const response = yield* Effect.tryPromise({
        try: async () =>
          fetch(publishUrl, {
            method: "POST",
            headers: signedRequest.headers as Record<string, string>,
            body,
          }),
        catch: (error) =>
          new Error(`Failed to publish event: ${String(error)}`),
      })

      if (!response.ok) {
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new Error("Failed to read response"),
        })
        yield* Effect.fail(
          new Error(`Failed to publish event: ${response.status} ${text}`),
        )
      }

      yield* Effect.logDebug(`Published to ${channel}`)
    })

  /**
   * Subscribe to a channel and receive messages as a Stream.
   */
  const subscribe = <T>(channel: string) =>
    Stream.asyncScoped<T, Error>((emit) =>
      Effect.gen(function* () {
        const { url, subprotocols } = yield* buildSignedWebSocketConnection

        yield* Effect.logInfo(`Connecting to ${url}`)

        const ws = new WebSocket(url, [...subprotocols])
        ws.on("open", () => {
          Effect.runSync(Effect.logInfo("WebSocket connected"))
          ws.send(JSON.stringify({ type: "connection_init" }))
        })

        ws.on("message", async (data) => {
          const message = JSON.parse(data.toString())

          if (message.type === "connection_ack") {
            Effect.runSync(Effect.logDebug("Connection acknowledged"))
            const auth = await Effect.runPromise(
              createSubscribeAuthorization(channel),
            )
            ws.send(
              JSON.stringify({
                type: "subscribe",
                id: "sub-1",
                channel,
                authorization: auth,
              }),
            )
          } else if (message.type === "subscribe_success") {
            Effect.runSync(Effect.logInfo(`Subscribed to ${channel}`))
          } else if (message.type === "data" && message.id === "sub-1") {
            try {
              const eventData = JSON.parse(message.event) as T
              emit.single(eventData)
            } catch (err) {
              Effect.runSync(
                Effect.logError(`Failed to parse event data: ${err}`),
              )
            }
          } else if (message.type === "error") {
            Effect.runSync(
              Effect.logError(`WebSocket error: ${JSON.stringify(message)}`),
            )
            emit.fail(
              new Error(
                message.errors
                  ?.map((e: { message: string }) => e.message)
                  .join(", ") ?? "Unknown error",
              ),
            )
          }
        })

        ws.on("error", (err) => {
          Effect.runSync(Effect.logError(`WebSocket error: ${err.message}`))
          emit.fail(new Error(err.message))
        })

        ws.on("close", () => {
          Effect.runSync(Effect.logInfo("WebSocket closed"))
          emit.end()
        })

        // Cleanup when scope closes
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.logInfo("Closing WebSocket")
            ws.close()
          }),
        )
      }),
    )

  /**
   * Subscribe to invocations for a function.
   */
  const subscribeToInvocations = (channel: string) =>
    subscribe<InvocationMessage>(channel)

  /**
   * Publish a response to a channel.
   */
  const publishResponse = (channel: string, response: ResponseMessage) =>
    publish(channel, response)

  return {
    publish,
    subscribe,
    subscribeToInvocations,
    publishResponse,
    createSubscribeAuthorization,
  }
}

/**
 * Type for the AppSync client.
 */
export type AppSyncClient = ReturnType<typeof makeAppSyncClient>
