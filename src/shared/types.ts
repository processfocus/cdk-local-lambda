/**
 * Shared constants and types used by bootstrap stack, aspect, and CLI.
 */

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
 * Name of the CDK bootstrap stack
 */
export const BOOTSTRAP_STACK_NAME = "CdkLocalLambdaBootstrapStack"

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
 * Channel name builders for AppSync Events
 */
export const buildChannelName = {
  /**
   * Channel for sending invocations to the daemon
   * Bridge -> Daemon
   */
  invocation: (functionName: string) => `/live/${functionName}/in`,

  /**
   * Channel for receiving responses from the daemon
   * Daemon -> Bridge
   */
  response: (functionName: string) => `/live/${functionName}/out`,
} as const
