/**
 * Simple adder handler that adds two numbers.
 *
 * This handler is used in a Docker Lambda to demonstrate
 * the live debugging workflow with DockerImageFunction.
 */

import type { Context } from "aws-lambda"

interface AdderEvent {
  a: number
  b: number
}

interface AdderResponse {
  result: number
  input: {
    a: number
    b: number
  }
  context: {
    functionName: string
    awsRequestId: string
  }
  timestamp: string
}

/**
 * Adder handler - adds two numbers and returns the result
 */
export async function handler(
  event: AdderEvent,
  context: Context,
): Promise<AdderResponse> {
  console.log("[Adder] Received event:", JSON.stringify(event))

  const { a, b } = event
  const result = a + b

  console.debug("ENV", process.env["TEST"])

  const response: AdderResponse = {
    result,
    input: { a, b },
    context: {
      functionName: context.functionName,
      awsRequestId: context.awsRequestId,
    },
    timestamp: new Date().toISOString(),
  }

  console.log("[Adder] Returning response:", JSON.stringify(response))

  return response
}
