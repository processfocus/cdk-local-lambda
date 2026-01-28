/**
 * Shared constants and types used by bootstrap stack, aspect, and CLI.
 */

import { createHash } from "node:crypto"

/**
 * SSM parameter paths for Live Lambda infrastructure
 * Base path for all Live Lambda SSM parameters
 */
export const SSM_BASE_PATH = "/cdk-local-lambda"

/**
 * Tag key used to store the local handler path on Lambda functions
 */
export const LIVE_LAMBDA_TAG = "live-lambda:handler"

/**
 * Tag key used to store the local Docker context path on DockerImageFunction.
 * The daemon uses this to build and run the container locally.
 */
export const LIVE_LAMBDA_DOCKER_TAG = "live-lambda:docker-context"

/**
 * Name of the CDK bootstrap stack
 */
export const BOOTSTRAP_STACK_NAME = "CdkLocalLambdaBootstrapStack"

/**
 * Current version of the bootstrap stack.
 * Increment this when making breaking changes to the bootstrap infrastructure.
 */
export const BOOTSTRAP_VERSION = "1"

/**
 * Environment variable names used by the bridge handler
 */
export const ENV_VARS = {
  HTTP_ENDPOINT: "APPSYNC_HTTP_ENDPOINT",
  REALTIME_ENDPOINT: "APPSYNC_REALTIME_ENDPOINT",
} as const

/**
 * Message types for AppSync Events communication
 */
export interface InvocationMessage {
  type: "invocation"
  requestId: string
  event: unknown
  context: LambdaContext
  /** Lambda environment variables (forwarded from bridge on first invocation) */
  env?: Record<string, string>
}

/**
 * Environment variables that are set locally by the daemon.
 * These override any values from the bridge Lambda and are excluded from forwarding.
 * Note: AWS_LAMBDA_FUNCTION_MEMORY_SIZE is also set locally but isn't in EXCLUDED_ENV_VARS
 * because it doesn't come from the bridge Lambda's process.env (it's in the context).
 */
export const LOCAL_OVERRIDE_ENV_VARS = new Set([
  // Set by daemon to point to local Runtime API server
  "AWS_LAMBDA_RUNTIME_API",
  // Local handler path (different from deployed handler)
  "_HANDLER",
  // Local project root
  "LAMBDA_TASK_ROOT",
])

/**
 * Environment variables to exclude when forwarding from Lambda.
 * These are either Lambda internals or should use local values instead.
 */
export const EXCLUDED_ENV_VARS = new Set([
  // Set locally by the daemon
  "_HANDLER",
  "LAMBDA_TASK_ROOT",
  // Lambda runtime internals
  "AWS_LAMBDA_RUNTIME_API",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_EXECUTION_ENV",
  "LAMBDA_RUNTIME_DIR",
  // Internal sockets
  "_LAMBDA_CONSOLE_SOCKET",
  "_LAMBDA_CONTROL_SOCKET",
  "_LAMBDA_LOG_FD",
  "_LAMBDA_SHARED_MEM_FD",
  "_LAMBDA_RUNTIME_LOAD_TIME",
  "_LAMBDA_SB_ID",
  "_LAMBDA_SERVER_PORT",
  // X-Ray not available locally
  "AWS_XRAY_DAEMON_ADDRESS",
  "AWS_XRAY_CONTEXT_MISSING",
  "_X_AMZN_TRACE_ID",
  // System vars - use local values
  "PATH",
  "PWD",
  "HOME",
  "USER",
  "SHELL",
  "SHLVL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "TZ",
])

/**
 * Filter environment variables for forwarding to local execution.
 * Removes Lambda internals and system variables that should use local values.
 */
export function filterEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !EXCLUDED_ENV_VARS.has(key)) {
      result[key] = value
    }
  }
  return result
}

export interface ResponseMessage {
  type: "response"
  requestId: string
  result?: unknown
  error?: ErrorPayload
}

export interface ErrorPayload {
  errorType: string
  errorMessage: string
  stackTrace?: string[]
}

export interface LambdaContext {
  functionName: string
  functionVersion: string
  invokedFunctionArn: string
  memoryLimitInMB: string
  awsRequestId: string
  logGroupName: string
  logStreamName: string
  getRemainingTimeInMillis: number
}

/**
 * Hash a function name for use in channel paths.
 * Uses first 16 hex chars of SHA256 to stay within AppSync limits.
 */
export function hashFunctionName(functionName: string): string {
  return createHash("sha256")
    .update(functionName)
    .digest("hex")
    .substring(0, 16)
}

/**
 * Channel name builders for AppSync Events
 */
export const buildChannelName = {
  /**
   * Channel for sending invocations to the daemon
   * Bridge -> Daemon
   */
  invocation: (functionName: string) =>
    `/live/${hashFunctionName(functionName)}/in`,

  /**
   * Channel for receiving responses from the daemon
   * Daemon -> Bridge
   */
  response: (functionName: string) =>
    `/live/${hashFunctionName(functionName)}/out`,
} as const
