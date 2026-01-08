/**
 * Functions to retrieve captured entry path and handler name from Lambda functions
 * that were created with NodejsFunction.
 *
 * The live-lambda-bootstrap.ts file installs a hook that captures these values
 * when NodejsFunction instances are created.
 */

import type * as lambda from "aws-cdk-lib/aws-lambda"

// Symbols used by the bootstrap hook to store captured values
const ENTRY_SYMBOL = Symbol.for("live-lambda:entry")
const HANDLER_SYMBOL = Symbol.for("live-lambda:handler")

/**
 * Get the entry path that was passed to NodejsFunction constructor.
 * Returns undefined if the function was not created with NodejsFunction
 * or if the hook was not installed.
 */
export function getEntryPath(fn: lambda.Function): string | undefined {
  return (fn as unknown as Record<symbol, string | undefined>)[ENTRY_SYMBOL]
}

/**
 * Get the handler name that was passed to NodejsFunction constructor.
 * Returns undefined if the function was not created with NodejsFunction
 * or if the hook was not installed.
 */
export function getHandlerName(fn: lambda.Function): string | undefined {
  return (fn as unknown as Record<symbol, string | undefined>)[HANDLER_SYMBOL]
}
