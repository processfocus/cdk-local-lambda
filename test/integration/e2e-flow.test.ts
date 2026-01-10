/**
 * End-to-end flow tests simulating complete bridge -> daemon -> bridge communication.
 *
 * These tests verify the full round-trip of Lambda invocations through AppSync Events.
 * Requires a deployed bootstrap stack.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test"

// Integration tests need longer timeout
setDefaultTimeout(60_000)
import type { Context } from "aws-lambda"
import { AppSyncEventsClient } from "../../src/functions/bridge/appsync-client"
import { handler } from "../../src/functions/bridge/handler"
import { clearEndpointCache } from "../../src/functions/bridge/ssm-config"
import {
  buildChannelName,
  type InvocationMessage,
  type ResponseMessage,
} from "../../src/shared/types"
import { getTestConfig, shouldSkipIntegrationTests } from "./setup"

/**
 * Simulates a daemon that listens for invocations and responds.
 */
async function simulateDaemon(
  client: AppSyncEventsClient,
  functionName: string,
  handler: (
    invocation: InvocationMessage,
  ) => ResponseMessage | Promise<ResponseMessage>,
): Promise<() => void> {
  const invocationChannel = buildChannelName.invocation(functionName)
  const responseChannel = buildChannelName.response(functionName)

  return client.subscribe<InvocationMessage>({
    channel: invocationChannel,
    onMessage: async (msg) => {
      const response = await handler(msg)
      await client.publish(responseChannel, response)
    },
  })
}

/**
 * Creates a mock Lambda context.
 */
function createMockContext(functionName: string, requestId: string): Context {
  return {
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
}

describe("E2E Flow", () => {
  const shouldSkip = shouldSkipIntegrationTests()

  let daemonClient: AppSyncEventsClient

  beforeEach(async () => {
    clearEndpointCache()
    if (!shouldSkip) {
      const config = await getTestConfig()
      daemonClient = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })
    }
  })

  afterEach(async () => {
    if (daemonClient) {
      await daemonClient.close()
    }
  })

  it.skipIf(shouldSkip)("complete invocation round-trip", async () => {
    const functionName = `e2e-roundtrip-${Date.now()}`
    const requestId = `req-${Date.now()}`
    const testEvent = { action: "greet", name: "World" }

    // Start simulated daemon
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      (invocation) => ({
        type: "response",
        requestId: invocation.requestId,
        result: {
          message: `Hello, ${(invocation.event as { name: string }).name}!`,
        },
      }),
    )

    // Invoke through bridge handler
    const context = createMockContext(functionName, requestId)
    const result = await handler(testEvent, context)

    expect(result).toEqual({ message: "Hello, World!" })

    unsubscribe()
  })

  it.skipIf(shouldSkip)("handles concurrent invocations", async () => {
    const functionName = `e2e-concurrent-${Date.now()}`

    // Start simulated daemon
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      async (invocation) => {
        // Simulate some processing time
        await new Promise((resolve) => setTimeout(resolve, 100))
        return {
          type: "response",
          requestId: invocation.requestId,
          result: {
            requestId: invocation.requestId,
            processed: true,
          },
        }
      },
    )

    // Send multiple concurrent invocations
    const invocations = Array.from({ length: 5 }, (_, i) => {
      const requestId = `req-${Date.now()}-${i}`
      const context = createMockContext(functionName, requestId)
      return handler({ index: i }, context)
    })

    const results = await Promise.all(invocations)

    // Each result should have correct requestId
    for (let i = 0; i < results.length; i++) {
      expect((results[i] as { processed: boolean }).processed).toBe(true)
      expect((results[i] as { requestId: string }).requestId).toContain(`-${i}`)
    }

    unsubscribe()
  })

  it.skipIf(shouldSkip)(
    "different functions use different channels",
    async () => {
      const functionName1 = `e2e-func1-${Date.now()}`
      const functionName2 = `e2e-func2-${Date.now()}`
      const receivedInvocations: { functionName: string; requestId: string }[] =
        []

      const config = await getTestConfig()
      const daemon2Client = new AppSyncEventsClient({
        httpEndpoint: config.httpEndpoint,
        realtimeEndpoint: config.realtimeEndpoint,
        region: config.region,
      })

      // Start daemon for function 1
      const unsub1 = await simulateDaemon(
        daemonClient,
        functionName1,
        (invocation) => {
          receivedInvocations.push({
            functionName: functionName1,
            requestId: invocation.requestId,
          })
          return {
            type: "response",
            requestId: invocation.requestId,
            result: { from: "daemon1" },
          }
        },
      )

      // Start daemon for function 2
      const unsub2 = await simulateDaemon(
        daemon2Client,
        functionName2,
        (invocation) => {
          receivedInvocations.push({
            functionName: functionName2,
            requestId: invocation.requestId,
          })
          return {
            type: "response",
            requestId: invocation.requestId,
            result: { from: "daemon2" },
          }
        },
      )

      // Invoke both functions
      const [result1, result2] = await Promise.all([
        handler({}, createMockContext(functionName1, "req-1")),
        handler({}, createMockContext(functionName2, "req-2")),
      ])

      // Verify each daemon received correct invocation
      expect(result1).toEqual({ from: "daemon1" })
      expect(result2).toEqual({ from: "daemon2" })
      expect(receivedInvocations).toHaveLength(2)
      expect(
        receivedInvocations.find((i) => i.functionName === functionName1),
      ).toBeDefined()
      expect(
        receivedInvocations.find((i) => i.functionName === functionName2),
      ).toBeDefined()

      unsub1()
      unsub2()
      await daemon2Client.close()
    },
  )

  it.skipIf(shouldSkip)("error response propagates correctly", async () => {
    const functionName = `e2e-error-${Date.now()}`
    const requestId = `req-${Date.now()}`

    // Start daemon that returns error
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      (invocation) => ({
        type: "response",
        requestId: invocation.requestId,
        error: {
          errorType: "CustomError",
          errorMessage: "Something went wrong in the daemon",
          stackTrace: [
            "at processRequest (daemon.ts:42:10)",
            "at handleMessage (daemon.ts:28:5)",
          ],
        },
      }),
    )

    const context = createMockContext(functionName, requestId)

    try {
      await handler({ trigger: "error" }, context)
      throw new Error("Expected handler to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe("CustomError")
      expect((err as Error).message).toBe("Something went wrong in the daemon")
      expect((err as Error).stack).toContain("processRequest")
    }

    unsubscribe()
  })

  it.skipIf(shouldSkip)("large payload handling", async () => {
    const functionName = `e2e-large-${Date.now()}`
    const requestId = `req-${Date.now()}`

    // Create a large payload (~50KB, under the 64KB AppSync limit)
    const largeData = "x".repeat(50_000)
    const largeEvent = { data: largeData }

    // Start daemon that echoes the event
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      (invocation) => ({
        type: "response",
        requestId: invocation.requestId,
        result: {
          received: true,
          dataLength: (invocation.event as { data: string }).data.length,
        },
      }),
    )

    const context = createMockContext(functionName, requestId)
    const result = await handler(largeEvent, context)

    expect(result).toEqual({
      received: true,
      dataLength: 50_000,
    })

    unsubscribe()
  })

  it.skipIf(shouldSkip)("handles empty response result", async () => {
    const functionName = `e2e-empty-${Date.now()}`
    const requestId = `req-${Date.now()}`

    // Start daemon that returns undefined result
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      (invocation) => ({
        type: "response",
        requestId: invocation.requestId,
        // No result field
      }),
    )

    const context = createMockContext(functionName, requestId)
    const result = await handler({}, context)

    expect(result).toBeUndefined()

    unsubscribe()
  })

  it.skipIf(shouldSkip)("handles null response result", async () => {
    const functionName = `e2e-null-${Date.now()}`
    const requestId = `req-${Date.now()}`

    // Start daemon that returns null result
    const unsubscribe = await simulateDaemon(
      daemonClient,
      functionName,
      (invocation) => ({
        type: "response",
        requestId: invocation.requestId,
        result: null,
      }),
    )

    const context = createMockContext(functionName, requestId)
    const result = await handler({}, context)

    expect(result).toBeNull()

    unsubscribe()
  })
})
