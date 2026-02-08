/**
 * Tests for Runtime API server queue behavior during container restarts.
 *
 * These tests verify that:
 * 1. Invocations queued before a container connects are delivered
 * 2. Invocations queued during a container restart are not lost
 * 3. New containers can pick up invocations from the queue
 *
 * This is critical behavior for the Docker file watching feature where
 * containers are rebuilt when source files change.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test"
import { Effect, Exit, Scope } from "effect"
import {
  queueInvocation,
  type RuntimeApiServer,
  startRuntimeApiServer,
  waitForResponse,
} from "../src/cli/runtime-api/server.js"
import type {
  LambdaInvocation,
  LambdaResponse,
} from "../src/cli/runtime-api/types.js"

// Tests involve HTTP requests and timing
setDefaultTimeout(30_000)

/**
 * Creates a test invocation with the given request ID.
 */
function createTestInvocation(
  requestId: string,
  event: unknown = { test: true },
): LambdaInvocation {
  return {
    requestId,
    event,
    deadlineMs: Date.now() + 30000,
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    functionName: "test-function",
    functionVersion: "$LATEST",
    memoryLimitMB: 128,
    logGroupName: "/aws/lambda/test",
    logStreamName: "test-stream",
  }
}

/**
 * Simulates a Lambda container polling for an invocation.
 * Returns the invocation data and request ID from headers.
 */
async function simulateContainerPoll(
  port: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ event: unknown; requestId: string }> {
  const response = await fetch(
    `http://localhost:${port}/2018-06-01/runtime/invocation/next`,
    { signal: options.signal },
  )

  if (!response.ok) {
    throw new Error(`Poll failed with status ${response.status}`)
  }

  const requestId = response.headers.get("Lambda-Runtime-Aws-Request-Id")
  if (!requestId) {
    throw new Error("Missing request ID header")
  }

  const event = await response.json()
  return { event, requestId }
}

/**
 * Simulates a Lambda container sending a response.
 */
async function simulateContainerResponse(
  port: number,
  requestId: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(
    `http://localhost:${port}/2018-06-01/runtime/invocation/${requestId}/response`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok) {
    throw new Error(`Response failed with status ${response.status}`)
  }
}

/**
 * Simulates a Lambda container sending an error.
 */
async function simulateContainerError(
  port: number,
  requestId: string,
  errorMessage: string,
  errorType = "Error",
): Promise<void> {
  const response = await fetch(
    `http://localhost:${port}/2018-06-01/runtime/invocation/${requestId}/error`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lambda-Runtime-Function-Error-Type": errorType,
      },
      body: JSON.stringify({ errorMessage }),
    },
  )

  if (!response.ok) {
    throw new Error(`Error response failed with status ${response.status}`)
  }
}

describe("Runtime API Queue Behavior", () => {
  let server: RuntimeApiServer
  let scope: Scope.CloseableScope

  beforeEach(async () => {
    // Create a new scope and start the server
    scope = Effect.runSync(Scope.make())
    server = await Effect.runPromise(
      startRuntimeApiServer().pipe(Scope.extend(scope)),
    )
  })

  afterEach(async () => {
    // Close the scope to stop the server
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  })

  it("delivers invocation queued before container connects", async () => {
    const invocation = createTestInvocation("pre-connect-1", {
      message: "hello",
    })

    // Queue the invocation BEFORE any container polls
    await Effect.runPromise(queueInvocation(server.state, invocation))

    // Now simulate a container connecting and polling
    const result = await simulateContainerPoll(server.port)

    expect(result.requestId).toBe("pre-connect-1")
    expect(result.event).toEqual({ message: "hello" })
  })

  it("delivers multiple queued invocations in order", async () => {
    // Queue multiple invocations
    await Effect.runPromise(
      Effect.all([
        queueInvocation(
          server.state,
          createTestInvocation("order-1", { seq: 1 }),
        ),
        queueInvocation(
          server.state,
          createTestInvocation("order-2", { seq: 2 }),
        ),
        queueInvocation(
          server.state,
          createTestInvocation("order-3", { seq: 3 }),
        ),
      ]),
    )

    // Fetch them one by one
    const result1 = await simulateContainerPoll(server.port)
    const result2 = await simulateContainerPoll(server.port)
    const result3 = await simulateContainerPoll(server.port)

    expect(result1.requestId).toBe("order-1")
    expect(result2.requestId).toBe("order-2")
    expect(result3.requestId).toBe("order-3")
  })

  it("container can respond to invocation", async () => {
    const invocation = createTestInvocation("respond-1", { a: 1, b: 2 })
    await Effect.runPromise(queueInvocation(server.state, invocation))

    // Container polls, processes, and responds
    const poll = await simulateContainerPoll(server.port)
    await simulateContainerResponse(server.port, poll.requestId, { sum: 3 })

    // Wait for the response
    const response = await Effect.runPromise(waitForResponse(server.state))

    expect(response).toEqual({
      requestId: "respond-1",
      body: { sum: 3 },
    })
  })

  it("container can report error", async () => {
    const invocation = createTestInvocation("error-1")
    await Effect.runPromise(queueInvocation(server.state, invocation))

    // Container polls and reports an error
    const poll = await simulateContainerPoll(server.port)
    await simulateContainerError(
      server.port,
      poll.requestId,
      "Division by zero",
      "ArithmeticError",
    )

    // Wait for the error response
    const response = await Effect.runPromise(waitForResponse(server.state))

    expect(response).toMatchObject({
      requestId: "error-1",
      errorType: "ArithmeticError",
      errorMessage: "Division by zero",
    })
  })

  it("invocation queued during container restart is picked up by new container", async () => {
    // This test simulates the rebuild scenario:
    // 1. Container is running
    // 2. Rebuild starts - old container is killed
    // 3. New invocation arrives while no container is connected
    // 4. New container starts and picks up the invocation

    // First, simulate an initial container processing an invocation
    const invocation1 = createTestInvocation("rebuild-1", { phase: "before" })
    await Effect.runPromise(queueInvocation(server.state, invocation1))

    const poll1 = await simulateContainerPoll(server.port)
    expect(poll1.requestId).toBe("rebuild-1")
    await simulateContainerResponse(server.port, poll1.requestId, {
      result: "done",
    })

    // Container is now "killed" (we just stop polling)
    // Queue a new invocation while no container is connected
    const invocation2 = createTestInvocation("rebuild-2", {
      phase: "during-rebuild",
    })
    await Effect.runPromise(queueInvocation(server.state, invocation2))

    // Simulate delay while container is rebuilding
    await new Promise((resolve) => setTimeout(resolve, 500))

    // New container starts and polls
    const poll2 = await simulateContainerPoll(server.port)

    // The invocation queued during "rebuild" should be delivered
    expect(poll2.requestId).toBe("rebuild-2")
    expect(poll2.event).toEqual({ phase: "during-rebuild" })
  })

  it("handles rapid container reconnection", async () => {
    // This tests that the polling mechanism handles rapid reconnects
    // which can happen during fast rebuilds

    // Simulate rapid connect/disconnect/reconnect cycle
    for (let i = 0; i < 3; i++) {
      // Queue an invocation
      const invocation = createTestInvocation(`rapid-${i}`, { iteration: i })
      await Effect.runPromise(queueInvocation(server.state, invocation))

      // Container connects, gets invocation, responds
      const poll = await simulateContainerPoll(server.port)
      expect(poll.requestId).toBe(`rapid-${i}`)
      await simulateContainerResponse(server.port, poll.requestId, { done: i })

      // Brief delay simulating container restart
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // Verify all responses were received
    for (let i = 0; i < 3; i++) {
      const response = await Effect.runPromise(waitForResponse(server.state))
      expect(response).toHaveProperty("requestId")
    }
  })

  it("poll request can be aborted without losing queued invocations", async () => {
    // This is the key behavior: if a container's poll request is aborted
    // (e.g., during container shutdown), invocations should NOT be lost

    // Start a poll that we'll abort
    const controller = new AbortController()

    // Start polling (this will block since queue is empty)
    const pollPromise = simulateContainerPoll(server.port, {
      signal: controller.signal,
    })

    // Let the poll start waiting
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Abort the request (simulating container being killed)
    controller.abort()

    // The poll should fail
    await expect(pollPromise).rejects.toThrow()

    // Now queue an invocation
    const invocation = createTestInvocation("after-abort-1", {
      status: "queued-after-abort",
    })
    await Effect.runPromise(queueInvocation(server.state, invocation))

    // A new container should be able to pick it up
    const result = await simulateContainerPoll(server.port)
    expect(result.requestId).toBe("after-abort-1")
    expect(result.event).toEqual({ status: "queued-after-abort" })
  })

  it("invocation queued while poll is waiting is delivered", async () => {
    // Test that an invocation queued while a container is waiting
    // is delivered to that container

    // Start polling (queue is empty, so it will wait)
    const pollPromise = simulateContainerPoll(server.port)

    // Let the poll start waiting
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Now queue an invocation
    const invocation = createTestInvocation("delayed-queue-1", {
      queued: "while-waiting",
    })
    await Effect.runPromise(queueInvocation(server.state, invocation))

    // The poll should receive it
    const result = await pollPromise
    expect(result.requestId).toBe("delayed-queue-1")
    expect(result.event).toEqual({ queued: "while-waiting" })
  })

  it.skip("complete rebuild scenario with concurrent invocation - Known issue with NodeHttpServer abort handling", async () => {
    // Full scenario test:
    // 1. Container A is processing invocations
    // 2. File change triggers rebuild
    // 3. Invocation arrives during rebuild
    // 4. Container B (rebuilt) picks up the invocation

    // Container A processes first invocation
    const inv1 = createTestInvocation("scenario-1")
    await Effect.runPromise(queueInvocation(server.state, inv1))
    const pollA1 = await simulateContainerPoll(server.port)
    await simulateContainerResponse(server.port, pollA1.requestId, {
      from: "containerA",
    })

    // Container A starts polling for next invocation
    const controllerA = new AbortController()
    const pollA2Promise = simulateContainerPoll(server.port, {
      signal: controllerA.signal,
    })

    // Let Container A start waiting
    await new Promise((resolve) => setTimeout(resolve, 100))

    // File change detected - rebuild starts
    // Container A is killed (abort its poll)
    controllerA.abort()
    await expect(pollA2Promise).rejects.toThrow()

    // Invocation arrives during rebuild (no container connected)
    const inv2 = createTestInvocation("scenario-2", { during: "rebuild" })
    await Effect.runPromise(queueInvocation(server.state, inv2))

    // Simulate rebuild time
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Container B starts (after rebuild)
    const pollB = await simulateContainerPoll(server.port)

    // Container B should receive the invocation queued during rebuild
    expect(pollB.requestId).toBe("scenario-2")
    expect(pollB.event).toEqual({ during: "rebuild" })

    // Container B responds successfully
    await simulateContainerResponse(server.port, pollB.requestId, {
      from: "containerB",
    })

    // Verify the response
    // Skip the first response (from inv1)
    await Effect.runPromise(waitForResponse(server.state))
    const response2 = await Effect.runPromise(waitForResponse(server.state))
    expect((response2 as LambdaResponse).body).toEqual({ from: "containerB" })
  })
})
