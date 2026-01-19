/**
 * Main entry point for local-live-lambda.
 *
 * Exports:
 * - LiveLambdaAspect: CDK Aspect to transform Lambda functions
 * - applyLiveLambdaAspect: Helper to apply the aspect if CDK_LIVE=true
 * - isLiveModeEnabled: Check if live mode is enabled
 * - CdkLocalLambdaBootstrapStack: The bootstrap stack for shared infrastructure
 *
 * For Docker function support, you must use a direct static import of the
 * bootstrap file BEFORE any CDK imports in your app entry point:
 *
 * ```typescript
 * import "local-live-lambda/lib/aspect/live-lambda-bootstrap.js"
 * import * as cdk from "aws-cdk-lib"
 * ```
 *
 * This ensures the hook is installed synchronously before CDK modules load.
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
