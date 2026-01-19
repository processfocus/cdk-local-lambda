/**
 * Integration tests for the bridge Lambda handler as a component.
 *
 * Tests the handler's responsibilities:
 * - SSM parameter reading and caching
 * - Invocation message structure (type, requestId, event, context)
 * - Response correlation by requestId
 * - Success and error result handling
 *
 * Requires a deployed bootstrap stack.
 */

import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test"

// Integration tests need longer timeout
setDefaultTimeout(30_000)

import type { Context } from "aws-lambda"
import { AppSyncEventsClient } from "../../src/functions/bridge/appsync-client"
import { handler } from "../../src/functions/bridge/handler"
import {
  clearEndpointCache,
  getAppSyncEndpoints,
} from "../../src/functions/bridge/ssm-config"
import {
  buildChannelName,
  type InvocationMessage,
  type ResponseMessage,
} from "../../src/shared/types"
import { getTestConfig } from "./setup"

describe("Bridge Handler", () => {
  beforeEach(() => {
    clearEndpointCache()
  })

  describe("SSM Integration", () => {
    it("reads AppSync endpoints from SSM", async () => {
      const endpoints = await getAppSyncEndpoints()

      expect(endpoints.httpEndpoint).toMatch(/^https:\/\//)
      expect(endpoints.httpEndpoint).toContain(".appsync-api.")
      expect(endpoints.realtimeEndpoint).toMatch(/^wss:\/\//)
      expect(endpoints.realtimeEndpoint).toContain(".appsync-realtime-api.")
    })

    it("caches SSM parameters", async () => {
      const endpoints1 = await getAppSyncEndpoints()
      const endpoints2 = await getAppSyncEndpoints()

      // Should return the same object reference (cached)
      expect(endpoints1).toBe(endpoints2)
    })

    it("returns fresh values after cache clear", async () => {
      const endpoints1 = await getAppSyncEndpoints()
      clearEndpointCache()
      const endpoints2 = await getAppSyncEndpoints()

      // Should have same values but different object references
      expect(endpoints1).not.toBe(endpoints2)
      expect(endpoints1.httpEndpoint).toBe(endpoints2.httpEndpoint)
    })
  })

  describe("Handler Invocation", () => {
    it("sends invocation with correct structure", async () => {
      const functionName = `test-function-${Date.now()}`
      const requestId = `req-${Date.now()}`
      const testEvent = { key: "value" }

      const mockContext: Context = {
        functionName,
        functionVersion: "$LATEST",
        invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        memoryLimitInMB: "128",
        awsRequestId: requestId,
        logGroupName: `/aws/lambda/${functionName}`,
        logStreamName: "2024/01/01/[$LATEST]abc123",
        getRemainingTimeInMillis: () => 290000,
        callbackWaitsForEmptyEventLoop: true,
        done: () => {},
        fail: () => {},
        succeed: () => {},
      }

      // Set up a listener for the invocation
      const config = await getTestConfig()
      const listenerClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const invocationChannel = buildChannelName.invocation(functionName)
      const responseChannel = buildChannelName.response(functionName)
      let receivedInvocation: InvocationMessage | null = null

      // Subscribe to invocation channel and respond
      await listenerClient.subscribe({
        channel: invocationChannel,
        onMessage: async (msg: InvocationMessage) => {
          receivedInvocation = msg
          // Send response
          const response: ResponseMessage = {
            type: "response",
            requestId: msg.requestId,
            result: { success: true },
          }
          await listenerClient.publish(responseChannel, response)
        },
      })

      // Invoke the handler
      const result = await handler(testEvent, mockContext)

      // Verify invocation structure
      expect(receivedInvocation).not.toBeNull()
      expect(receivedInvocation!.type).toBe("invocation")
      expect(receivedInvocation!.requestId).toBe(requestId)
      expect(receivedInvocation!.event).toEqual(testEvent)
      expect(receivedInvocation!.context.functionName).toBe(functionName)
      expect(receivedInvocation!.context.awsRequestId).toBe(requestId)

      // Verify result
      expect(result).toEqual({ success: true })

      await listenerClient.close()
    })

    it("correlates response by requestId", async () => {
      const functionName = `test-correlate-${Date.now()}`
      const requestId = `req-${Date.now()}`

      const mockContext: Context = {
        functionName,
        functionVersion: "$LATEST",
        invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        memoryLimitInMB: "128",
        awsRequestId: requestId,
        logGroupName: `/aws/lambda/${functionName}`,
        logStreamName: "2024/01/01/[$LATEST]abc123",
        getRemainingTimeInMillis: () => 290000,
        callbackWaitsForEmptyEventLoop: true,
        done: () => {},
        fail: () => {},
        succeed: () => {},
      }

      const config = await getTestConfig()
      const listenerClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const invocationChannel = buildChannelName.invocation(functionName)
      const responseChannel = buildChannelName.response(functionName)

      await listenerClient.subscribe({
        channel: invocationChannel,
        onMessage: async (msg: InvocationMessage) => {
          // Send wrong requestId first
          await listenerClient.publish(responseChannel, {
            type: "response",
            requestId: "wrong-id",
            result: { wrong: true },
          })
          // Then send correct one
          await listenerClient.publish(responseChannel, {
            type: "response",
            requestId: msg.requestId,
            result: { correct: true },
          })
        },
      })

      const result = await handler({ test: true }, mockContext)

      // Should get the correct response
      expect(result).toEqual({ correct: true })

      await listenerClient.close()
    })

    it("returns success result", async () => {
      const functionName = `test-success-${Date.now()}`
      const requestId = `req-${Date.now()}`

      const mockContext: Context = {
        functionName,
        functionVersion: "$LATEST",
        invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        memoryLimitInMB: "128",
        awsRequestId: requestId,
        logGroupName: `/aws/lambda/${functionName}`,
        logStreamName: "2024/01/01/[$LATEST]abc123",
        getRemainingTimeInMillis: () => 290000,
        callbackWaitsForEmptyEventLoop: true,
        done: () => {},
        fail: () => {},
        succeed: () => {},
      }

      const config = await getTestConfig()
      const listenerClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const invocationChannel = buildChannelName.invocation(functionName)
      const responseChannel = buildChannelName.response(functionName)
      const expectedResult = {
        statusCode: 200,
        body: { message: "Hello from local!" },
      }

      await listenerClient.subscribe({
        channel: invocationChannel,
        onMessage: async (msg: InvocationMessage) => {
          await listenerClient.publish(responseChannel, {
            type: "response",
            requestId: msg.requestId,
            result: expectedResult,
          })
        },
      })

      const result = await handler({}, mockContext)

      expect(result).toEqual(expectedResult)

      await listenerClient.close()
    })

    it("throws error for error response", async () => {
      const functionName = `test-error-${Date.now()}`
      const requestId = `req-${Date.now()}`

      const mockContext: Context = {
        functionName,
        functionVersion: "$LATEST",
        invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        memoryLimitInMB: "128",
        awsRequestId: requestId,
        logGroupName: `/aws/lambda/${functionName}`,
        logStreamName: "2024/01/01/[$LATEST]abc123",
        getRemainingTimeInMillis: () => 290000,
        callbackWaitsForEmptyEventLoop: true,
        done: () => {},
        fail: () => {},
        succeed: () => {},
      }

      const config = await getTestConfig()
      const listenerClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const invocationChannel = buildChannelName.invocation(functionName)
      const responseChannel = buildChannelName.response(functionName)

      await listenerClient.subscribe({
        channel: invocationChannel,
        onMessage: async (msg: InvocationMessage) => {
          await listenerClient.publish(responseChannel, {
            type: "response",
            requestId: msg.requestId,
            error: {
              errorType: "ValidationError",
              errorMessage: "Invalid input provided",
              stackTrace: ["at handler (index.js:10:5)"],
            },
          })
        },
      })

      await expect(handler({}, mockContext)).rejects.toThrow(
        "Invalid input provided",
      )

      await listenerClient.close()
    })

    it("includes function context in invocation", async () => {
      const functionName = `test-context-${Date.now()}`
      const requestId = `req-${Date.now()}`

      const mockContext: Context = {
        functionName,
        functionVersion: "$LATEST",
        invokedFunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`,
        memoryLimitInMB: "256",
        awsRequestId: requestId,
        logGroupName: `/aws/lambda/${functionName}`,
        logStreamName: "2024/01/01/[$LATEST]abc123",
        getRemainingTimeInMillis: () => 250000,
        callbackWaitsForEmptyEventLoop: true,
        done: () => {},
        fail: () => {},
        succeed: () => {},
      }

      const config = await getTestConfig()
      const listenerClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      const invocationChannel = buildChannelName.invocation(functionName)
      const responseChannel = buildChannelName.response(functionName)
      let receivedContext: InvocationMessage["context"] | null = null

      await listenerClient.subscribe({
        channel: invocationChannel,
        onMessage: async (msg: InvocationMessage) => {
          receivedContext = msg.context
          await listenerClient.publish(responseChannel, {
            type: "response",
            requestId: msg.requestId,
            result: {},
          })
        },
      })

      await handler({}, mockContext)

      expect(receivedContext).not.toBeNull()
      expect(receivedContext!.functionName).toBe(functionName)
      expect(receivedContext!.functionVersion).toBe("$LATEST")
      expect(receivedContext!.invokedFunctionArn).toContain(functionName)
      expect(receivedContext!.memoryLimitInMB).toBe("256")
      expect(receivedContext!.awsRequestId).toBe(requestId)
      expect(receivedContext!.logGroupName).toContain(functionName)
      expect(typeof receivedContext!.getRemainingTimeInMillis).toBe("number")

      await listenerClient.close()
    })
  })
})
