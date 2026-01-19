/**
 * Integration tests for the AppSyncEventsClient class.
 *
 * Tests the client primitives in isolation:
 * - publish() - sending messages via HTTP
 * - subscribe() - receiving messages via WebSocket
 * - publishAndWaitForResponse() - request-response pattern
 * - Connection state management (isConnected, close)
 *
 * Requires a deployed bootstrap stack with AppSync Events.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test"

// Integration tests need longer timeout
setDefaultTimeout(30_000)

import { AppSyncEventsClient } from "../../src/functions/bridge/appsync-client"
import { getTestConfig } from "./setup"

describe("AppSyncEventsClient", () => {
  let client: AppSyncEventsClient

  beforeEach(async () => {
    const config = await getTestConfig()
    client = new AppSyncEventsClient({
      httpEndpoint: config.httpEndpoint,
      realtimeEndpoint: config.realtimeEndpoint,
      region: config.region,
    })
  })

  afterEach(async () => {
    if (client) {
      await client.close()
    }
  })

  describe("publish", () => {
    it("can publish message to channel", async () => {
      const testChannel = `/live/test/${Date.now()}`
      const testMessage = { type: "test", data: "hello" }

      // Publishing should succeed
      await expect(
        client.publish(testChannel, testMessage),
      ).resolves.toBeUndefined()
    })

    it("fails with invalid endpoint", async () => {
      const badClient = new AppSyncEventsClient({
        httpEndpoint:
          "https://invalid.appsync-api.us-east-1.amazonaws.com/event",
        realtimeEndpoint:
          "wss://invalid.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
      })

      const testChannel = `/live/test/${Date.now()}`
      await expect(
        badClient.publish(testChannel, { test: true }),
      ).rejects.toThrow()
    })
  })

  describe("subscribe", () => {
    it("can subscribe to channel", async () => {
      const testChannel = `/live/test/${Date.now()}`
      const messages: unknown[] = []

      const unsubscribe = await client.subscribe({
        channel: testChannel,
        onMessage: (msg) => {
          messages.push(msg)
        },
      })

      expect(client.isConnected()).toBe(true)
      unsubscribe()
      expect(client.isConnected()).toBe(false)
    })

    it("receives published messages on subscription", async () => {
      const testChannel = `/live/test/${Date.now()}`
      const receivedMessages: unknown[] = []
      let messageReceived: () => void

      const messagePromise = new Promise<void>((resolve) => {
        messageReceived = resolve
      })

      // Subscribe first
      await client.subscribe({
        channel: testChannel,
        onMessage: (msg) => {
          receivedMessages.push(msg)
          messageReceived()
        },
      })

      // Publish a message using a second client
      const config = await getTestConfig()
      const publishClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const testMessage = { type: "test", value: Date.now() }
      await publishClient.publish(testChannel, testMessage)

      // Wait for message to be received
      await messagePromise

      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0]).toEqual(testMessage)
    })
  })

  describe("publishAndWaitForResponse", () => {
    it("returns matching response", async () => {
      const testId = Date.now().toString()
      const publishChannel = `/live/test/pub/${testId}`
      const subscribeChannel = `/live/test/sub/${testId}`

      // Set up a responder in a separate client
      const config = await getTestConfig()
      const responderClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      // Subscribe to publish channel and respond on subscribe channel
      await responderClient.subscribe({
        channel: publishChannel,
        onMessage: async (msg: { requestId: string }) => {
          await responderClient.publish(subscribeChannel, {
            requestId: msg.requestId,
            result: "success",
          })
        },
      })

      // Now send request and wait for response
      const response = await client.publishAndWaitForResponse<{
        requestId: string
        result: string
      }>({
        publishChannel,
        subscribeChannel,
        message: { requestId: "req-123" },
        timeoutMs: 10_000,
        matchResponse: (msg) => msg.requestId === "req-123",
      })

      expect(response.requestId).toBe("req-123")
      expect(response.result).toBe("success")

      await responderClient.close()
    })

    it("ignores non-matching messages", async () => {
      const testId = Date.now().toString()
      const publishChannel = `/live/test/pub/${testId}`
      const subscribeChannel = `/live/test/sub/${testId}`

      const config = await getTestConfig()
      const responderClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      // Subscribe and send wrong response first, then correct one
      await responderClient.subscribe({
        channel: publishChannel,
        onMessage: async (msg: { requestId: string }) => {
          // Send wrong response first
          await responderClient.publish(subscribeChannel, {
            requestId: "wrong-id",
            result: "wrong",
          })
          // Then send correct response
          await responderClient.publish(subscribeChannel, {
            requestId: msg.requestId,
            result: "correct",
          })
        },
      })

      const response = await client.publishAndWaitForResponse<{
        requestId: string
        result: string
      }>({
        publishChannel,
        subscribeChannel,
        message: { requestId: "req-456" },
        timeoutMs: 10_000,
        matchResponse: (msg) => msg.requestId === "req-456",
      })

      expect(response.requestId).toBe("req-456")
      expect(response.result).toBe("correct")

      await responderClient.close()
    })

    it("times out when no response", async () => {
      const testId = Date.now().toString()
      const publishChannel = `/live/test/pub/${testId}`
      const subscribeChannel = `/live/test/sub/${testId}`

      await expect(
        client.publishAndWaitForResponse({
          publishChannel,
          subscribeChannel,
          message: { requestId: "req-timeout" },
          timeoutMs: 1_000,
          matchResponse: () => true,
        }),
      ).rejects.toThrow(/timeout/i)
    })
  })

  describe("isConnected", () => {
    it("returns false when not connected", () => {
      expect(client.isConnected()).toBe(false)
    })

    it("returns true after subscribing", async () => {
      const testChannel = `/live/test/${Date.now()}`
      await client.subscribe({
        channel: testChannel,
        onMessage: () => {},
      })
      expect(client.isConnected()).toBe(true)
    })

    it("returns false after close", async () => {
      const testChannel = `/live/test/${Date.now()}`
      await client.subscribe({
        channel: testChannel,
        onMessage: () => {},
      })
      await client.close()
      expect(client.isConnected()).toBe(false)
    })
  })

  describe("close", () => {
    it("terminates WebSocket cleanly", async () => {
      const testChannel = `/live/test/${Date.now()}`
      await client.subscribe({
        channel: testChannel,
        onMessage: () => {},
      })

      expect(client.isConnected()).toBe(true)
      await client.close()
      expect(client.isConnected()).toBe(false)
    })

    it("can be called multiple times safely", async () => {
      const testChannel = `/live/test/${Date.now()}`
      await client.subscribe({
        channel: testChannel,
        onMessage: () => {},
      })

      await client.close()
      await client.close()
      await client.close()
      // Should not throw
    })
  })
})
