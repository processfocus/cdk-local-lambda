/**
 * SSM parameter reader for AppSync endpoints.
 *
 * Reads the AppSync HTTP and realtime endpoints from SSM Parameter Store
 * and caches them to avoid repeated SSM calls during Lambda warm starts.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { SSM_BASE_PATH } from "../../shared/types.js"

export interface AppSyncEndpoints {
  httpEndpoint: string
  realtimeEndpoint: string
}

// Cache endpoints to avoid repeated SSM calls
let cachedEndpoints: AppSyncEndpoints | null = null

/**
 * Get AppSync endpoints from SSM Parameter Store.
 * Results are cached after the first call.
 */
export async function getAppSyncEndpoints(): Promise<AppSyncEndpoints> {
  if (cachedEndpoints) return cachedEndpoints

  const client = new SSMClient({})
  const qualifier = process.env.CDK_BOOTSTRAP_QUALIFIER ?? "hnb659fds"
  const basePath = `${SSM_BASE_PATH}/${qualifier}`

  const [httpResponse, realtimeResponse] = await Promise.all([
    client.send(
      new GetParameterCommand({
        Name: `${basePath}/http-endpoint`,
      }),
    ),
    client.send(
      new GetParameterCommand({
        Name: `${basePath}/realtime-endpoint`,
      }),
    ),
  ])

  if (!httpResponse.Parameter?.Value || !realtimeResponse.Parameter?.Value) {
    throw new Error(
      `[LiveLambda] SSM parameters not found at ${basePath}. ` +
        "Ensure the bootstrap stack is deployed.",
    )
  }

  cachedEndpoints = {
    httpEndpoint: httpResponse.Parameter.Value,
    realtimeEndpoint: realtimeResponse.Parameter.Value,
  }

  return cachedEndpoints
}

/**
 * Clear the cached endpoints. Useful for testing.
 */
export function clearEndpointCache(): void {
  cachedEndpoints = null
}
