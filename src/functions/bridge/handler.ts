/**
 * Bridge Lambda handler that forwards invocations to the local daemon via AppSync Events.
 *
 * This handler:
 * 1. Receives Lambda invocations from AWS
 * 2. Publishes the invocation to AppSync Events channel
 * 3. Subscribes to response channel
 * 4. Waits for the daemon to process and respond
 * 5. Returns the response or throws an error
 *
 * The AppSync endpoints are baked in at deploy time by the bridge-builder custom resource.
 */

import type { Context } from "aws-lambda"
import {
  buildChannelName,
  type InvocationMessage,
  type ResponseMessage,
} from "../../shared/types.js"
import { AppSyncEventsClient } from "./appsync-client.js"

// These placeholders are replaced by the bridge-builder at deploy time
const HTTP_ENDPOINT = "__APPSYNC_HTTP_ENDPOINT__"
const REALTIME_ENDPOINT = "__APPSYNC_REALTIME_ENDPOINT__"

// Timeout waiting for daemon response (ms)
const RESPONSE_TIMEOUT_MS = 290_000 // 4:50 to leave buffer for 5 min Lambda timeout

/**
 * Main Lambda handler - forwards all invocations to the local daemon
 */
export async function handler(
  event: unknown,
  context: Context,
): Promise<unknown> {
  const functionName = context.functionName
  const requestId = context.awsRequestId

  console.log(`[Bridge] Processing invocation for ${functionName}`)
  console.log(`[Bridge] Request ID: ${requestId}`)

  // Create AppSync client
  const client = new AppSyncEventsClient({
    httpEndpoint: HTTP_ENDPOINT,
    realtimeEndpoint: REALTIME_ENDPOINT,
  })

  // Build channel names
  const invocationChannel = buildChannelName.invocation(functionName)
  const responseChannel = buildChannelName.response(functionName)

  try {
    // Create the invocation message
    const invocationMessage: InvocationMessage = {
      type: "invocation",
      requestId,
      event,
      context: {
        functionName: context.functionName,
        functionVersion: context.functionVersion,
        invokedFunctionArn: context.invokedFunctionArn,
        memoryLimitInMB: context.memoryLimitInMB,
        awsRequestId: context.awsRequestId,
        logGroupName: context.logGroupName,
        logStreamName: context.logStreamName,
        getRemainingTimeInMillis: context.getRemainingTimeInMillis(),
      },
    }

    // Subscribe to response channel first, then publish invocation
    const response = await client.publishAndWaitForResponse<ResponseMessage>({
      publishChannel: invocationChannel,
      subscribeChannel: responseChannel,
      message: invocationMessage,
      timeoutMs: RESPONSE_TIMEOUT_MS,
      matchResponse: (msg) => msg.requestId === requestId,
    })

    console.log(`[Bridge] Received response for ${requestId}`)

    // Check for error response
    if (response.error) {
      const error = new Error(response.error.errorMessage)
      error.name = response.error.errorType
      if (response.error.stackTrace) {
        error.stack = response.error.stackTrace.join("\n")
      }
      throw error
    }

    return response.result
  } finally {
    // Clean up client connection
    await client.close()
  }
}
