/**
 * Utilities for accessing captured DockerImageFunction context paths.
 *
 * The actual hook is installed by importing live-lambda-bootstrap.ts first.
 * This file provides the getter functions for the aspect to use.
 */

import type * as lambda from "aws-cdk-lib/aws-lambda"

// Symbol to store docker context path on the function instance
// Must match the symbol used in live-lambda-bootstrap.ts
const DOCKER_CONTEXT_SYMBOL = Symbol.for("live-lambda:docker-context")

/**
 * Type for a function instance with captured docker props.
 */
interface FunctionWithCapturedDockerProps {
  [DOCKER_CONTEXT_SYMBOL]?: string
}

/**
 * Get the stored Docker context path for a Lambda function.
 * Returns undefined if the function wasn't created via DockerImageFunction
 * with fromImageAsset, or if the hook wasn't installed.
 */
export function getDockerContextPath(fn: lambda.Function): string | undefined {
  const value = (fn as unknown as FunctionWithCapturedDockerProps)[
    DOCKER_CONTEXT_SYMBOL
  ]
  return typeof value === "string" ? value : undefined
}

/**
 * Check if a Lambda function is a DockerImageFunction.
 * This checks both the CDK type and if we have captured docker context.
 */
export function isDockerImageFunction(fn: lambda.Function): boolean {
  // Check if we captured docker context via the hook
  const hasDockerContext = getDockerContextPath(fn) !== undefined

  // Also check the CfnFunction for package type
  const cfnFunction = fn.node.defaultChild as lambda.CfnFunction | undefined
  const isImagePackageType = cfnFunction?.packageType === "Image"

  return hasDockerContext || isImagePackageType
}
