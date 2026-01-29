/**
 * CDK Aspect to transform Lambda functions for live debugging
 *
 * When applied to a CDK app/stack, this aspect:
 * 1. Replaces Lambda code with the bridge handler from the bootstrap stack's S3 bucket
 * 2. Grants IAM permissions for AppSync Events
 * 3. Adds a tag with the local handler path for the daemon to discover
 *
 * The bridge uses AWS_LAMBDA_FUNCTION_NAME (auto-injected by Lambda) for channel routing.
 * The daemon discovers functions by querying Lambda API for functions with the live-lambda tag.
 */

import * as cdk from "aws-cdk-lib"
import * as iam from "aws-cdk-lib/aws-iam"
import type * as lambda from "aws-cdk-lib/aws-lambda"
import * as ssm from "aws-cdk-lib/aws-ssm"
import type { IConstruct } from "constructs"
import {
  LIVE_LAMBDA_DOCKER_TAG,
  LIVE_LAMBDA_TAG,
  SSM_BASE_PATH,
} from "../shared/types.js"
import {
  getDockerContextPath,
  isDockerImageFunction,
} from "./docker-function-hook.js"
import { getEntryPath, getHandlerName } from "./nodejs-function-hook.js"

// Regex to strip file extension from entry path
const EXTENSION_REGEX = /\.(ts|js|mjs|cjs|mts|cts)$/

/**
 * Properties for LiveLambdaAspect
 */
export interface LiveLambdaAspectProps {
  /**
   * The stack name to use for channel routing.
   * If not provided, uses the stack name from the function's stack.
   */
  stackName?: string

  /**
   * Optional: Pattern to match function construct IDs to transform.
   * If not provided, all Lambda functions are transformed.
   */
  functionPattern?: RegExp

  /**
   * Optional: Function construct IDs to exclude from transformation.
   */
  excludeFunctions?: string[]
}

/**
 * CDK Aspect that transforms Lambda functions for live debugging.
 *
 * Usage in bin/app.ts:
 * ```typescript
 * const app = new cdk.App();
 * const stack = new MyStack(app, 'MyStack');
 *
 * if (process.env.CDK_LIVE === 'true') {
 *   cdk.Aspects.of(app).add(new LiveLambdaAspect());
 * }
 * ```
 */
export class LiveLambdaAspect implements cdk.IAspect {
  private readonly props: LiveLambdaAspectProps
  private readonly processedFunctions: Set<string> = new Set()

  constructor(props: LiveLambdaAspectProps = {}) {
    this.props = props
  }

  visit(node: IConstruct): void {
    // Check if this is a Lambda Function using duck-typing instead of instanceof
    // This avoids issues with multiple copies of aws-cdk-lib being loaded
    if (!this.isLambdaFunction(node)) {
      return
    }

    // Cast to lambda.Function for type checking (we've verified it's a Lambda)
    const fn = node as unknown as lambda.Function

    // Skip if already processed (aspects can visit multiple times)
    const nodeId = node.node.addr
    if (this.processedFunctions.has(nodeId)) {
      return
    }

    // Generate a unique function ID from the construct path
    const functionId = this.generateFunctionId(fn)

    // Check exclusion list
    if (this.props.excludeFunctions?.includes(functionId)) {
      console.log(`[LiveLambda] Skipping excluded function: ${functionId}`)
      return
    }

    // Check pattern match
    if (
      this.props.functionPattern &&
      !this.props.functionPattern.test(functionId)
    ) {
      console.log(`[LiveLambda] Skipping non-matching function: ${functionId}`)
      return
    }

    console.log(`[LiveLambda] Transforming function: ${functionId}`)

    const stackName = this.props.stackName || cdk.Stack.of(fn).stackName

    // Check if this is a DockerImageFunction
    const isDockerFunction = isDockerImageFunction(fn)

    if (isDockerFunction) {
      console.log(`[LiveLambda] Detected DockerImageFunction: ${functionId}`)
      this.transformDockerFunction(fn, stackName, functionId)
    } else {
      // Get handler paths before we modify anything
      const { originalHandler, localHandler } = this.getHandlerPaths(fn)

      // Transform the function
      this.transformFunction(
        fn,
        stackName,
        functionId,
        originalHandler,
        localHandler,
      )
    }

    this.processedFunctions.add(nodeId)
  }

  /**
   * Check if a construct is a Lambda Function using duck-typing.
   * This avoids instanceof issues when multiple copies of aws-cdk-lib are loaded.
   */
  private isLambdaFunction(node: IConstruct): boolean {
    // Check by constructor name - handles Function, DockerImageFunction, NodejsFunction, etc.
    // Also handles our patched versions like DockerImageFunctionWithCapture
    const constructorName = node.constructor.name
    // CDK appends "2" to class names in some versions
    const isFunction =
      constructorName === "Function" ||
      constructorName === "Function2" ||
      constructorName.endsWith("Function") ||
      constructorName.endsWith("Function2") ||
      constructorName.includes("Function") // Catch patched versions like DockerImageFunctionWithCapture

    if (!isFunction) {
      return false
    }

    // Exclude CfnFunction (the L1 construct)
    if (constructorName === "CfnFunction") {
      return false
    }

    // Verify it has expected Lambda Function properties
    const maybeFunction = node as unknown as {
      functionName?: unknown
      functionArn?: unknown
      node?: { defaultChild?: unknown }
    }

    // Must have functionName and functionArn (IFunction interface)
    if (!maybeFunction.functionName || !maybeFunction.functionArn) {
      return false
    }

    // Must have a defaultChild (the CfnFunction)
    if (!maybeFunction.node?.defaultChild) {
      return false
    }

    return true
  }

  private generateFunctionId(fn: lambda.Function): string {
    // Use the construct ID as the function ID
    // For nested constructs, join with dashes
    const parts = fn.node.path.split("/")
    // Skip first part (App) and take the rest
    const relevantParts = parts.slice(1)
    return relevantParts.join("-").replace(/[^a-zA-Z0-9-]/g, "-")
  }

  /**
   * Get handler paths for a function.
   * Returns both the original handler (as set in CfnFunction) and the local handler path.
   */
  private getHandlerPaths(fn: lambda.Function): {
    originalHandler: string
    localHandler: string
  } {
    const cfnFunction = fn.node.defaultChild as lambda.CfnFunction
    const originalHandler = cfnFunction.handler || "index.handler"
    const constructId = fn.node.id

    // Check if captured by the NodejsFunction hook
    const entryPath = getEntryPath(fn)
    const handlerName = getHandlerName(fn) || "handler"
    if (entryPath) {
      // Convert entry path to local handler path
      // e.g., "functions/s3-writer/handler.ts" + "handler" -> "functions/s3-writer/handler.handler"
      const localHandler = `${entryPath.replace(EXTENSION_REGEX, "")}.${handlerName}`
      console.log(
        `[LiveLambda] Using captured entry for ${constructId}: ${localHandler}`,
      )
      return { originalHandler, localHandler }
    }

    // No handler path found - fail with helpful error
    throw new Error(
      `[LiveLambda] No local handler path for "${constructId}". ` +
        `This function was not created with NodejsFunction, or the bootstrap hook was not installed early enough. ` +
        `Fix: import "local-live-lambda/bootstrap" before any CDK imports (Node.js), ` +
        `or run Bun with "bun --preload local-live-lambda/bootstrap".`,
    )
  }

  /**
   * Transform a DockerImageFunction to use the bridge Docker image.
   * Stores the local Docker context path in a tag for the daemon to build/run locally.
   */
  private transformDockerFunction(
    fn: lambda.Function,
    _stackName: string,
    functionId: string,
  ): void {
    const cfnFunction = fn.node.defaultChild as lambda.CfnFunction
    const stack = cdk.Stack.of(fn)

    // Get the docker context path from the hook
    const dockerContextPath = getDockerContextPath(fn)
    if (!dockerContextPath) {
      throw new Error(
        `[LiveLambda] No docker context path for "${functionId}". ` +
          `The bootstrap hook was not installed early enough. ` +
          `Fix: import "local-live-lambda/bootstrap" before any CDK imports (Node.js), ` +
          `or run Bun with "bun --preload local-live-lambda/bootstrap".`,
      )
    }

    // Get SSM parameters
    const bootstrapQualifier =
      stack.node.tryGetContext("@aws-cdk/core:bootstrapQualifier") ||
      "hnb659fds"
    const ssmBasePath = `${SSM_BASE_PATH}/${bootstrapQualifier}`

    const apiArn = ssm.StringParameter.valueForStringParameter(
      stack,
      `${ssmBasePath}/api-arn`,
    )

    // Determine architecture and get appropriate bridge image
    const architecture = this.getArchitecture(cfnFunction)
    const bridgeImageParam =
      architecture === "arm64" ? "bridge-image-arm64" : "bridge-image-x86_64"

    const bridgeImageUri = ssm.StringParameter.valueForStringParameter(
      stack,
      `${ssmBasePath}/${bridgeImageParam}`,
    )

    // Add tag with docker context path for daemon discovery
    // The daemon uses this tag to build and run the container locally
    cfnFunction.tags.setTag(LIVE_LAMBDA_DOCKER_TAG, dockerContextPath)

    // Grant permissions to publish/subscribe to AppSync Events
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "appsync:EventConnect",
          "appsync:EventPublish",
          "appsync:EventSubscribe",
        ],
        resources: [apiArn, `${apiArn}/*`],
      }),
    )

    // Grant permissions to read SSM parameters (bridge needs AppSync endpoints)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${ssmBasePath}/*`,
        ],
      }),
    )

    // Increase timeout to allow for local debugging
    cfnFunction.timeout = 300 // 5 minutes

    // Replace the Docker image with the bridge image
    cfnFunction.code = {
      imageUri: bridgeImageUri,
    }

    console.log(
      `[LiveLambda] Replaced Docker image with bridge (${architecture})`,
    )
  }

  /**
   * Determine the architecture of a Lambda function.
   * Defaults to x86_64 if not explicitly set.
   */
  private getArchitecture(cfnFunction: lambda.CfnFunction): "arm64" | "x86_64" {
    const architectures = cfnFunction.architectures as string[] | undefined
    if (architectures?.includes("arm64")) {
      return "arm64"
    }
    return "x86_64"
  }

  private transformFunction(
    fn: lambda.Function,
    _stackName: string,
    _functionId: string,
    _originalHandler: string,
    localHandler: string,
  ): void {
    const cfnFunction = fn.node.defaultChild as lambda.CfnFunction
    const stack = cdk.Stack.of(fn)

    // Read values from SSM parameters (created by bootstrap stack)
    // Use the CDK bootstrap qualifier for proper scoping
    const bootstrapQualifier =
      stack.node.tryGetContext("@aws-cdk/core:bootstrapQualifier") ||
      "hnb659fds"
    const ssmBasePath = `${SSM_BASE_PATH}/${bootstrapQualifier}`

    const apiArn = ssm.StringParameter.valueForStringParameter(
      stack,
      `${ssmBasePath}/api-arn`,
    )
    const bridgeBucket = ssm.StringParameter.valueForStringParameter(
      stack,
      `${ssmBasePath}/bridge-bucket`,
    )
    const bridgeKey = ssm.StringParameter.valueForStringParameter(
      stack,
      `${ssmBasePath}/bridge-key`,
    )

    // Add tag with local handler path for daemon discovery
    // The daemon queries Lambda API for functions with this tag
    cfnFunction.tags.setTag(LIVE_LAMBDA_TAG, localHandler)

    // Grant permissions to publish/subscribe to AppSync Events
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "appsync:EventConnect",
          "appsync:EventPublish",
          "appsync:EventSubscribe",
        ],
        resources: [apiArn, `${apiArn}/*`],
      }),
    )

    // Grant permissions to read SSM parameters (bridge needs AppSync endpoints)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${ssmBasePath}/*`,
        ],
      }),
    )

    // Increase timeout to allow for local debugging
    cfnFunction.timeout = 300 // 5 minutes

    // Replace the code with bridge handler from bootstrap stack's S3 bucket
    cfnFunction.code = {
      s3Bucket: bridgeBucket,
      s3Key: bridgeKey,
    }
    cfnFunction.handler = "index.handler"
  }
}

/**
 * Helper function to check if live mode is enabled
 */
export function isLiveModeEnabled(): boolean {
  return process.env.CDK_LIVE === "true"
}

/**
 * Apply live lambda aspect to a CDK app or stack if live mode is enabled.
 *
 * @param scope The CDK app or stack to apply the aspect to
 * @param props Optional configuration for the live lambda aspect
 */
export function applyLiveLambdaAspect(
  scope: IConstruct,
  props: LiveLambdaAspectProps = {},
): void {
  if (!isLiveModeEnabled()) {
    console.log(
      "[LiveLambda] Live mode not enabled (set CDK_LIVE=true to enable)",
    )
    return
  }

  console.log("[LiveLambda] Live mode enabled - transforming Lambda functions")
  cdk.Aspects.of(scope).add(new LiveLambdaAspect(props))
}
