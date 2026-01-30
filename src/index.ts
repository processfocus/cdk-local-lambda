/**
 * Main entry point for cdk-local-lambda.
 *
 * Exports:
 * - LiveLambdaAspect: CDK Aspect to transform Lambda functions
 * - applyLiveLambdaAspect: Helper to apply the aspect if CDK_LIVE=true
 * - isLiveModeEnabled: Check if live mode is enabled
 * - CdkLocalLambdaBootstrapStack: The bootstrap stack for shared infrastructure
 *
 * For Docker function support, you must install the bootstrap BEFORE any CDK
 * imports in your app entry point:
 *
 * ```typescript
 * import "cdk-local-lambda/bootstrap"
 * import * as cdk from "aws-cdk-lib"
 * ```
 *
 * Node.js: this is sufficient.
 * Bun: use `bun --preload cdk-local-lambda/bootstrap` (static ESM imports are
 * linked before this module runs).
 */

// Re-export the aspect and helpers
export {
  applyLiveLambdaAspect,
  isLiveModeEnabled,
  LiveLambdaAspect,
  type LiveLambdaAspectProps,
} from "./aspect/live-lambda-aspect.js"

// Re-export the bootstrap stack
export {
  CdkLocalLambdaBootstrapStack,
  type CdkLocalLambdaBootstrapStackProps,
} from "./bootstrap-stack/bootstrap-stack.js"

// Re-export shared types
export {
  buildChannelName,
  type ErrorPayload,
  hashFunctionName,
  type InvocationMessage,
  type LambdaContext,
  LIVE_LAMBDA_DOCKER_TAG,
  LIVE_LAMBDA_TAG,
  type ResponseMessage,
  SSM_BASE_PATH,
} from "./shared/types.js"
