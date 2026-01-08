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

    const request = new HttpRequest({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
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

    // Make the HTTP request
    const response = await fetch(url.href, {
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
   * Connect to WebSocket and subscribe to a channel
   */
  private async connectAndSubscribe<T>(
    channel: string,
    onMessage: (message: T) => boolean,
  ): Promise<void> {
    // Build signed WebSocket URL
    const wsUrl = await this.buildSignedWebSocketUrl()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, ["aws-appsync-event-ws", "header-"])

      this.ws.on("open", () => {
        console.log("[Bridge] WebSocket connected")
        // Send connection init
        this.ws?.send(JSON.stringify({ type: "connection_init" }))
      })

      this.ws.on("message", (data) => {
        const message = JSON.parse(data.toString())

        if (message.type === "connection_ack") {
          console.log("[Bridge] Connection acknowledged")
          // Subscribe to channel
          this.ws?.send(
            JSON.stringify({
              type: "subscribe",
              id: "sub-1",
              channel,
            }),
          )
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
   * Build a signed WebSocket URL for AppSync Events
   */
  private async buildSignedWebSocketUrl(): Promise<string> {
    const url = new URL(this.realtimeEndpoint)

    // Create a canonical request for WebSocket connection
    const request = new HttpRequest({
      method: "GET",
      protocol: "https:",
      hostname: url.hostname,
      path: "/event/realtime",
      headers: {
        host: url.hostname,
      },
    })

    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: this.region,
      service: "appsync",
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    // Encode headers as base64 for WebSocket protocol
    const headerPayload = {
      host: url.hostname,
      ...Object.fromEntries(
        Object.entries(signedRequest.headers).filter(([key]) =>
          key.toLowerCase().startsWith("x-amz-"),
        ),
      ),
    }

    const encodedHeader = Buffer.from(JSON.stringify(headerPayload)).toString(
      "base64",
    )

    // Build WebSocket URL
    return `${this.realtimeEndpoint}?header=${encodeURIComponent(encodedHeader)}&payload=e30=`
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
