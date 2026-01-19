/**
 * Types for Lambda Runtime API implementation.
 *
 * This implements the AWS Lambda Runtime API that Docker containers use
 * to communicate with the Lambda runtime environment.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

/**
 * Lambda invocation context passed via headers and body
 */
export interface LambdaInvocation {
  /** Unique request ID for this invocation */
  requestId: string
  /** Event payload */
  event: unknown
  /** Function ARN */
  invokedFunctionArn: string
  /** Deadline timestamp in milliseconds since epoch */
  deadlineMs: number
  /** Function name */
  functionName: string
  /** Function version */
  functionVersion: string
  /** Memory limit in MB */
  memoryLimitMB: number
  /** Log group name */
  logGroupName: string
  /** Log stream name */
  logStreamName: string
}

/**
 * Response from the Lambda handler
 */
export interface LambdaResponse {
  /** Request ID this response is for */
  requestId: string
  /** Response body (JSON) */
  body: unknown
}

/**
 * Error response from the Lambda handler
 */
export interface LambdaError {
  /** Request ID this error is for */
  requestId: string
  /** Error type (e.g., "Runtime.UnhandledPromiseRejection") */
  errorType: string
  /** Error message */
  errorMessage: string
  /** Stack trace lines */
  stackTrace?: string[]
}

/**
 * Init error (error during handler initialization)
 */
export interface LambdaInitError {
  /** Error type */
  errorType: string
  /** Error message */
  errorMessage: string
  /** Stack trace lines */
  stackTrace?: string[]
}

/**
 * Runtime API server configuration
 */
export interface RuntimeApiConfig {
  /** Port to listen on (0 for ephemeral) */
  port: number
  /** Host to bind to */
  host: string
}

/**
 * State of a pending invocation
 */
export type InvocationState =
  | { type: "pending"; invocation: LambdaInvocation }
  | { type: "completed"; response: LambdaResponse }
  | { type: "error"; error: LambdaError }
  | { type: "init-error"; error: LambdaInitError }

/**
 * Headers returned by GET /invocation/next
 */
export interface InvocationNextHeaders {
  "Lambda-Runtime-Aws-Request-Id": string
  "Lambda-Runtime-Deadline-Ms": string
  "Lambda-Runtime-Invoked-Function-Arn": string
  "Lambda-Runtime-Log-Group-Name"?: string
  "Lambda-Runtime-Log-Stream-Name"?: string
  "Lambda-Runtime-Trace-Id"?: string
}
