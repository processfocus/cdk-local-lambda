/**
 * Bootstrap file that installs the NodejsFunction hook BEFORE any CDK imports.
 *
 * This must be imported as the very first thing in the CDK app entry point,
 * before any other imports. It patches Module._load to intercept when
 * aws-cdk-lib/aws-lambda-nodejs is loaded, wrapping NodejsFunction to
 * capture the entry and handler props on each instance.
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

// Symbol to store entry path on the function instance
const ENTRY_SYMBOL = Symbol.for("live-lambda:entry")
const HANDLER_SYMBOL = Symbol.for("live-lambda:handler")

/**
 * Check if a module request is for aws-lambda-nodejs.
 * We need to match:
 * - "aws-cdk-lib/aws-lambda-nodejs" (direct import)
 * - Paths ending with "/aws-lambda-nodejs" (resolved paths)
 * - Paths containing "/aws-lambda-nodejs/" (submodule imports)
 */
function isLambdaNodejsModule(request: string): boolean {
  return (
    request === "aws-cdk-lib/aws-lambda-nodejs" ||
    request.endsWith("/aws-lambda-nodejs") ||
    request.includes("/aws-lambda-nodejs/")
  )
}

// Module type for the lambda-nodejs exports
interface LambdaNodejsModule {
  NodejsFunction: NodejsFunctionConstructor & {
    __liveLambdaPatched?: boolean
  }
}

// Constructor type that can be extended
interface NodejsFunctionConstructor {
  new (
    scope: unknown,
    id: string,
    props?: NodejsFunctionProps,
  ): NodejsFunctionInstance
  prototype: NodejsFunctionInstance
}

interface NodejsFunctionInstance {
  node: { addr: string }
}

interface NodejsFunctionProps {
  entry?: string
  handler?: string
}

// Install the Module._load hook immediately
const Module = require("node:module")
const originalLoad: (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) => unknown = Module._load

Module._load = function (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
): unknown {
  // Call original load - let errors propagate naturally
  const result = originalLoad.call(this, request, parent, isMain)

  // Check if this is the lambda-nodejs module
  if (isLambdaNodejsModule(request)) {
    const module = result as LambdaNodejsModule | null

    // If already patched, skip
    if (module?.NodejsFunction?.__liveLambdaPatched) {
      return result
    }

    // Check if we can patch
    if (module?.NodejsFunction) {
      const OriginalNodejsFunction = module.NodejsFunction

      // Create wrapper class that captures entry/handler props
      class NodejsFunctionWithCapture extends OriginalNodejsFunction {
        constructor(
          scope: unknown,
          id: string,
          props: NodejsFunctionProps = {},
        ) {
          super(scope, id, props)

          // Store the entry path on the instance (validate it's a non-empty string)
          if (
            typeof props.entry === "string" &&
            props.entry.trim().length > 0
          ) {
            ;(this as unknown as Record<symbol, string>)[ENTRY_SYMBOL] =
              props.entry
          }

          // Store the handler name (validate and default to 'handler')
          const handler =
            typeof props.handler === "string" && props.handler.trim().length > 0
              ? props.handler
              : "handler"
          ;(this as unknown as Record<symbol, string>)[HANDLER_SYMBOL] = handler
        }

        static __liveLambdaPatched = true
      }

      // Try to replace - fail if we can't
      try {
        Object.defineProperty(module, "NodejsFunction", {
          value: NodejsFunctionWithCapture,
          writable: true,
          configurable: true,
        })
      } catch (err) {
        console.error(
          "[LiveLambda] FATAL: Cannot patch NodejsFunction - module is frozen or sealed.",
        )
        console.error(
          "[LiveLambda] This can happen with certain bundlers or Node.js configurations.",
        )
        console.error("[LiveLambda] Error:", (err as Error).message)
        process.exit(1)
      }
    }
  }

  return result
}
