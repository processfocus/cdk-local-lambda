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
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as ssm from "aws-cdk-lib/aws-ssm"
import type { IConstruct } from "constructs"
import { LIVE_LAMBDA_TAG, SSM_BASE_PATH } from "../shared/types.js"
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

  /**
   * Optional: Explicit mapping of function construct IDs to their local handler paths.
   * Use this when the automatic detection doesn't work or you need custom paths.
   * Example: { "MyFunction": "src/functions/my-function/index.handler" }
   */
  handlerMappings?: Record<string, string>
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
    // Only process Lambda functions
    if (!(node instanceof lambda.Function)) {
      return
    }

    // Skip if already processed (aspects can visit multiple times)
    const nodeId = node.node.addr
    if (this.processedFunctions.has(nodeId)) {
      return
    }

    // Generate a unique function ID from the construct path
    const functionId = this.generateFunctionId(node)

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

    // Get handler paths before we modify anything
    const { originalHandler, localHandler } = this.getHandlerPaths(node)
    const stackName = this.props.stackName || cdk.Stack.of(node).stackName

    // Transform the function
    this.transformFunction(
      node,
      stackName,
      functionId,
      originalHandler,
      localHandler,
    )

    this.processedFunctions.add(nodeId)
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

    // 1. Check if the user provided an explicit handler mapping in the aspect props
    if (this.props.handlerMappings?.[constructId]) {
      const localHandler = this.props.handlerMappings[constructId]
      console.log(
        `[LiveLambda] Using handlerMappings for ${constructId}: ${localHandler}`,
      )
      return { originalHandler, localHandler }
    }

    // 2. Check if captured by the NodejsFunction hook
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
        `This function was not created with NodejsFunction, or the hook was not installed. ` +
        `Either use NodejsFunction with an explicit 'entry' prop, ` +
        `or pass handlerMappings to applyLiveLambdaAspect().`,
    )
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
