/**
 * Test setup for integration tests.
 *
 * Reads AppSync endpoints from SSM Parameter Store for use in tests.
 * Requires a deployed bootstrap stack.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { SSM_BASE_PATH } from "../../src/shared/types"

export interface TestConfig {
  httpEndpoint: string
  realtimeEndpoint: string
  region: string
}

let testConfig: TestConfig | null = null

/**
 * Get test configuration from SSM Parameter Store.
 * Caches the result for subsequent calls.
 */
export async function getTestConfig(): Promise<TestConfig> {
  if (testConfig) return testConfig

  const region = process.env.AWS_REGION ?? "us-east-1"
  const qualifier = process.env.CDK_BOOTSTRAP_QUALIFIER ?? "hnb659fds"
  const basePath = `${SSM_BASE_PATH}/${qualifier}`

  const client = new SSMClient({ region })

  const [httpResponse, realtimeResponse] = await Promise.all([
    client.send(new GetParameterCommand({ Name: `${basePath}/http-endpoint` })),
    client.send(
      new GetParameterCommand({ Name: `${basePath}/realtime-endpoint` }),
    ),
  ])

  if (!httpResponse.Parameter?.Value || !realtimeResponse.Parameter?.Value) {
    throw new Error(
      `SSM parameters not found at ${basePath}. ` +
        "Deploy the bootstrap stack first: bun run cdk deploy CdkLocalLambdaBootstrapStack",
    )
  }

  testConfig = {
    httpEndpoint: httpResponse.Parameter.Value,
    realtimeEndpoint: realtimeResponse.Parameter.Value,
    region,
  }

  return testConfig
}

/**
 * Clear the cached test config. Useful for test isolation.
 */
export function clearTestConfig(): void {
  testConfig = null
}
