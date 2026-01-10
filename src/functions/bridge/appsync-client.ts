/**
 * AppSync Events client with AWS SigV4 signing.
 *
 * This client handles:
 * - HTTP requests to publish events (with IAM signing)
 * - WebSocket connections for real-time subscriptions (with IAM signing)
 */

import { Sha256 } from "@aws-crypto/sha256-js"
import { defaultProvider } from "@aws-sdk/credential-provider-node"
import { HttpRequest } from "@aws-sdk/protocol-http"
import { SignatureV4 } from "@aws-sdk/signature-v4"
import WebSocket from "ws"

export interface AppSyncEventsClientConfig {
  httpEndpoint: string
  realtimeEndpoint: string
  region?: string
}

export interface PublishAndWaitOptions<T> {
  publishChannel: string
  subscribeChannel: string
  message: unknown
  timeoutMs: number
  matchResponse: (message: T) => boolean
}

export interface SubscriptionOptions<T> {
  channel: string
  onMessage: (message: T) => void | Promise<void>
  onError?: (error: Error) => void
}

/**
 * Client for AppSync Events API
 */
export class AppSyncEventsClient {
  private readonly httpEndpoint: string
  private readonly realtimeEndpoint: string
  private readonly region: string
  private ws: WebSocket | null = null

  constructor(config: AppSyncEventsClientConfig) {
    this.httpEndpoint = config.httpEndpoint
    this.realtimeEndpoint = config.realtimeEndpoint
    // Extract region from endpoint URL
    // Format: https://{api-id}.appsync-api.{region}.amazonaws.com/event
    const match = config.httpEndpoint.match(/\.([a-z0-9-]+)\.amazonaws\.com/)
    this.region =
      config.region ?? match?.[1] ?? process.env.AWS_REGION ?? "us-east-1"
  }

  /**
   * Publish a message to a channel and wait for a response on another channel.
   */
  async publishAndWaitForResponse<T>(
    options: PublishAndWaitOptions<T>,
  ): Promise<T> {
    const {
      publishChannel,
      subscribeChannel,
      message,
      timeoutMs,
      matchResponse,
    } = options

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.close()
        reject(new Error(`Timeout waiting for response after ${timeoutMs}ms`))
      }, timeoutMs)

      // Set up WebSocket connection first
      this.connectAndSubscribe<T>(subscribeChannel, (receivedMessage) => {
        if (matchResponse(receivedMessage)) {
          clearTimeout(timeoutId)
          resolve(receivedMessage)
          return true // Signal to stop listening
        }
        return false
      })
        .then(() => {
          // Once subscribed, publish the message
          return this.publish(publishChannel, message)
        })
        .catch((err) => {
          clearTimeout(timeoutId)
          reject(err)
        })
    })
  }

  /**
   * Publish a message to a channel via HTTP
   */
  async publish(channel: string, message: unknown): Promise<void> {
    const url = new URL(this.httpEndpoint)
    const body = JSON.stringify({
      channel,
      events: [JSON.stringify(message)],
    })

    // AppSync Events requires /event path for publishing
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

    // Sign the request
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: this.region,
      service: "appsync",
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    // Make the HTTP request - use the correct endpoint with /event path
    const publishUrl = `${url.protocol}//${url.hostname}${path}`
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: signedRequest.headers as Record<string, string>,
      body,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to publish event: ${response.status} ${text}`)
    }
  }

  /**
   * Subscribe to a channel and receive messages continuously.
   * Returns an unsubscribe function.
   */
  async subscribe<T>(options: SubscriptionOptions<T>): Promise<() => void> {
    const { channel, onMessage, onError } = options

    await this.connectAndSubscribeContinuous<T>(channel, onMessage, onError)

    return () => {
      this.close()
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Connect to WebSocket and subscribe to a channel
   */
  private async connectAndSubscribe<T>(
    channel: string,
    onMessage: (message: T) => boolean,
  ): Promise<void> {
    // Build signed WebSocket connection
    const [wsUrl, subprotocols] = await this.buildSignedWebSocketConnection()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, subprotocols)

      this.ws.on("open", () => {
        console.log("[Bridge] WebSocket connected")
        // Send connection init
        this.ws?.send(JSON.stringify({ type: "connection_init" }))
      })

      this.ws.on("message", (data) => {
        const message = JSON.parse(data.toString())

        if (message.type === "connection_ack") {
          console.log("[Bridge] Connection acknowledged")
          // Subscribe to channel with authorization
          this.createSubscribeAuthorization(channel).then((auth) => {
            this.ws?.send(
              JSON.stringify({
                type: "subscribe",
                id: "sub-1",
                channel,
                authorization: auth,
              }),
            )
          })
        } else if (message.type === "subscribe_success") {
          console.log(`[Bridge] Subscribed to ${channel}`)
          resolve()
        } else if (message.type === "data" && message.id === "sub-1") {
          // Parse the event data
          try {
            const eventData = JSON.parse(message.event) as T
            const shouldStop = onMessage(eventData)
            if (shouldStop) {
              this.close()
            }
          } catch (err) {
            console.error("[Bridge] Failed to parse event data:", err)
          }
        } else if (message.type === "error") {
          console.error("[Bridge] WebSocket error:", message)
          reject(
            new Error(
              message.errors
                ?.map((e: { message: string }) => e.message)
                .join(", ") ?? "Unknown error",
            ),
          )
        }
      })

      this.ws.on("error", (err) => {
        console.error("[Bridge] WebSocket error:", err)
        reject(err)
      })

      this.ws.on("close", () => {
        console.log("[Bridge] WebSocket closed")
      })
    })
  }

  /**
   * Connect to WebSocket and subscribe to a channel with continuous message handling.
   * Unlike connectAndSubscribe, this doesn't close after receiving a message.
   */
  private async connectAndSubscribeContinuous<T>(
    channel: string,
    onMessage: (message: T) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    // Build signed WebSocket connection
    const [wsUrl, subprotocols] = await this.buildSignedWebSocketConnection()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, subprotocols)

      this.ws.on("open", () => {
        console.log("[AppSync] WebSocket connected")
        // Send connection init
        this.ws?.send(JSON.stringify({ type: "connection_init" }))
      })

      this.ws.on("message", async (data) => {
        const message = JSON.parse(data.toString())

        if (message.type === "connection_ack") {
          console.log("[AppSync] Connection acknowledged")
          // Subscribe to channel with authorization
          this.createSubscribeAuthorization(channel).then((auth) => {
            this.ws?.send(
              JSON.stringify({
                type: "subscribe",
                id: "sub-1",
                channel,
                authorization: auth,
              }),
            )
          })
        } else if (message.type === "subscribe_success") {
          console.log(`[AppSync] Subscribed to ${channel}`)
          resolve()
        } else if (message.type === "data" && message.id === "sub-1") {
          // Parse the event data
          try {
            const eventData = JSON.parse(message.event) as T
            await onMessage(eventData)
          } catch (err) {
            console.error("[AppSync] Failed to parse event data:", err)
            onError?.(err instanceof Error ? err : new Error(String(err)))
          }
        } else if (message.type === "error") {
          console.error("[AppSync] WebSocket error:", message)
          const error = new Error(
            message.errors
              ?.map((e: { message: string }) => e.message)
              .join(", ") ?? "Unknown error",
          )
          onError?.(error)
          reject(error)
        }
      })

      this.ws.on("error", (err) => {
        console.error("[AppSync] WebSocket error:", err)
        onError?.(err)
        reject(err)
      })

      this.ws.on("close", () => {
        console.log("[AppSync] WebSocket closed")
      })
    })
  }

  /**
   * Create authorization headers for subscribe operation
   */
  private async createSubscribeAuthorization(
    channel: string,
  ): Promise<Record<string, string>> {
    const httpUrl = new URL(this.httpEndpoint)
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

    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: this.region,
      service: "appsync",
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

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
      auth["x-amz-security-token"] = signedRequest.headers["x-amz-security-token"]
    }

    return auth
  }

  /**
   * Build signed WebSocket connection info for AppSync Events
   * Returns [url, subprotocols] for WebSocket constructor
   */
  private async buildSignedWebSocketConnection(): Promise<
    [string, string[]]
  > {
    const realtimeUrl = new URL(this.realtimeEndpoint)
    realtimeUrl.pathname = "/event/realtime"
    const httpUrl = new URL(this.httpEndpoint)

    // For IAM auth, sign a POST request to the HTTP endpoint
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

    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: this.region,
      service: "appsync",
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    // Build header payload for subprotocol - include all signed headers
    const headerPayload: Record<string, string> = {
      accept: "application/json, text/javascript",
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=UTF-8",
      host: httpUrl.hostname,
      "x-amz-date": signedRequest.headers["x-amz-date"],
      "x-amz-content-sha256": signedRequest.headers["x-amz-content-sha256"],
      Authorization: signedRequest.headers["authorization"],
    }

    // Add session token if present
    if (signedRequest.headers["x-amz-security-token"]) {
      headerPayload["x-amz-security-token"] =
        signedRequest.headers["x-amz-security-token"]
    }

    // Base64url encode (no padding, URL-safe)
    const encodedHeader = Buffer.from(JSON.stringify(headerPayload))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

    // Auth is passed as header-{base64url} subprotocol
    const authSubprotocol = `header-${encodedHeader}`

    return [realtimeUrl.toString(), ["aws-appsync-event-ws", authSubprotocol]]
  }

  /**
   * Close the WebSocket connection
   */
  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
