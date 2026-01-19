/**
 * Simple echo handler that returns the input event.
 *
 * This handler is used in a Bun-based Docker Lambda to demonstrate
 * the live debugging workflow with DockerImageFunction.
 */

import type { Context } from "aws-lambda"

interface EchoResponse {
  message: string
  event: unknown
  context: {
    functionName: string
    functionVersion: string
    awsRequestId: string
    memoryLimitInMB: string
  }
  timestamp: string
}

/**
 * Echo handler - returns the event along with context info
 */
export async function handler(
  event: unknown,
  context: Context,
): Promise<EchoResponse> {
  console.log("[Echo] Received event:", JSON.stringify(event))

  const response: EchoResponse = {
    message: "Hello from the echo handler!",
    event,
    context: {
      functionName: context.functionName,
      functionVersion: context.functionVersion,
      awsRequestId: context.awsRequestId,
      memoryLimitInMB: context.memoryLimitInMB,
    },
    timestamp: new Date().toISOString(),
  }

  console.log("[Echo] Returning response:", JSON.stringify(response))

  return response
}
