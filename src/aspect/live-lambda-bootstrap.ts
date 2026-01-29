/**
 * Bootstrap file that installs hooks for NodejsFunction and DockerImageFunction
 * BEFORE any CDK imports.
 *
 * This must be imported as the very first thing in the CDK app entry point,
 * before any other imports.
 *
 * Runtime support:
 * - Node.js: patches Module._load to intercept module loading
 * - Bun: directly imports and patches modules (Module._load not supported)
 *
 * Hooks installed:
 * - NodejsFunction: captures entry and handler props
 * - DockerImageFunction: captures docker context path from code prop
 * - DockerImageCode.fromImageAsset: captures the directory path
 */

import { createRequire } from "node:module"

const requireFromPackage = createRequire(import.meta.url)

// Prefer resolving dependencies from the *CDK app project* (process.cwd()).
// This avoids patching a nested aws-cdk-lib copy when local-live-lambda is
// installed with its own node_modules (common with package managers).
let requireFromProject = requireFromPackage
try {
  requireFromProject = createRequire(`${process.cwd()}/package.json`)
} catch {
  // Fall back to resolving relative to this package.
}

/**
 * Detect if we're running in Bun runtime
 */
const isBun = typeof process.versions.bun !== "undefined"

// Symbols for NodejsFunction
const ENTRY_SYMBOL = Symbol.for("live-lambda:entry")
const HANDLER_SYMBOL = Symbol.for("live-lambda:handler")

// Symbols for DockerImageFunction
const DOCKER_CONTEXT_SYMBOL = Symbol.for("live-lambda:docker-context")

/**
 * Map to store docker context paths captured from DockerImageCode.fromImageAsset
 * Key is the DockerImageCode instance, value is the context path
 */
const dockerImageCodeContextMap = new WeakMap<object, string>()

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

/**
 * Check if a module request is for aws-lambda (for DockerImageFunction).
 * We need to match:
 * - "aws-cdk-lib/aws-lambda" (direct import)
 * - Paths ending with "/aws-lambda" (resolved paths)
 * - Paths containing "/aws-lambda/" (submodule imports)
 */
function isLambdaModule(request: string): boolean {
  // Be careful not to match aws-lambda-nodejs
  if (request.includes("aws-lambda-nodejs")) {
    return false
  }
  return (
    request === "aws-cdk-lib/aws-lambda" ||
    request.endsWith("/aws-lambda") ||
    request.includes("/aws-lambda/")
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
  code?: unknown // lambda.Code - if provided, bundling is skipped
}

// Module type for the lambda exports
interface LambdaModule {
  DockerImageFunction: DockerImageFunctionConstructor & {
    __liveLambdaPatched?: boolean
  }
  DockerImageCode: DockerImageCodeStatic & {
    __liveLambdaPatched?: boolean
  }
}

// DockerImageFunction constructor type
interface DockerImageFunctionConstructor {
  new (
    scope: unknown,
    id: string,
    props: DockerImageFunctionProps,
  ): DockerImageFunctionInstance
  prototype: DockerImageFunctionInstance
}

interface DockerImageFunctionInstance {
  node: { addr: string }
}

interface DockerImageFunctionProps {
  code: DockerImageCodeInstance
  [key: string]: unknown
}

// DockerImageCode static type
interface DockerImageCodeStatic {
  fromImageAsset(
    directory: string,
    props?: DockerImageAssetProps,
  ): DockerImageCodeInstance
}

interface DockerImageCodeInstance {
  // Marker to identify docker image code instances
  __isDockerImageCode?: boolean
}

interface DockerImageAssetProps {
  file?: string
  cmd?: string[]
  [key: string]: unknown
}

// Cache the lambda module for creating dummy code
let cachedLambdaModule: LambdaModule | null = null

/**
 * Install hooks based on runtime environment.
 *
 * Bun notes:
 * - Bun creates a *snapshot* of CommonJS named exports when importing from ESM.
 *   This means that mutating/replacing `module.exports.Foo` AFTER the ESM import
 *   was linked will not affect `import { Foo } from "..."` in the current process.
 * - Therefore, Bun patching only works reliably when this bootstrap runs before
 *   the app entry point is loaded, e.g. via `bun --preload local-live-lambda/bootstrap`.
 *
 * Node.js:
 * - We can patch Module._load to intercept module loading.
 */
if (isBun) {
  const isLiveMode = process.env.CDK_LIVE === "true"

  // Best-effort patching for Bun. This is only guaranteed to work when this file
  // is preloaded (see note above). Even then, we keep this logic lightweight.
  if (isLiveMode) {
    const hasPreloadFlag = process.execArgv.includes("--preload")

    if (!hasPreloadFlag) {
      console.warn(
        "[LiveLambda] Warning: Running in Bun without --preload. Automatic handler/docker detection is likely disabled.",
      )
      console.warn(
        "[LiveLambda] Fix: run Bun with `--preload local-live-lambda/bootstrap`.",
      )
    }

    try {
      // Patch aws-lambda first so NodejsFunction can create dummy Code.fromInline
      // when CDK_LIVE=true (skips bundling).
      const lambdaModule = requireFromProject(
        "aws-cdk-lib/aws-lambda",
      ) as LambdaModule
      cachedLambdaModule = lambdaModule
      patchDockerImageFunction(lambdaModule)

      const nodejsModule = requireFromProject(
        "aws-cdk-lib/aws-lambda-nodejs",
      ) as LambdaNodejsModule
      patchNodejsFunction(nodejsModule)
    } catch (err) {
      console.warn(
        "[LiveLambda] Warning: Failed to install Bun patches:",
        (err as Error).message,
      )
      console.warn(
        "[LiveLambda] Automatic handler/docker detection is required; ensure bootstrap is preloaded.",
      )
      console.warn(
        "[LiveLambda] See: https://github.com/berenddeboer/cdk-local-lambda#bun-support",
      )
    }
  }
} else {
  // Node.js: use Module._load hook to intercept module loading
  const Module = requireFromPackage("node:module")
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
      patchNodejsFunction(result as LambdaNodejsModule | null)
    }

    // Check if this is the lambda module (for DockerImageFunction and Code.fromInline)
    if (isLambdaModule(request)) {
      // Cache the lambda module so we can use Code.fromInline in NodejsFunction patch
      cachedLambdaModule = result as LambdaModule | null
      patchDockerImageFunction(result as LambdaModule | null)
    }

    return result
  }
}

/**
 * Create a dummy inline code that does nothing.
 * Used to skip bundling when CDK_LIVE=true.
 */
function createDummyCode(lambdaModule: LambdaModule): unknown {
  // Access lambda.Code.fromInline to create a no-op code
  // This avoids bundling entirely since we provide pre-built code
  const Code = (
    lambdaModule as unknown as {
      Code?: { fromInline?: (code: string) => unknown }
    }
  ).Code
  if (Code?.fromInline) {
    return Code.fromInline("// Placeholder - replaced by LiveLambdaAspect")
  }
  return undefined
}

/**
 * Patch NodejsFunction to capture entry and handler props
 */
function patchNodejsFunction(module: LambdaNodejsModule | null): void {
  // If already patched, skip
  if (module?.NodejsFunction?.__liveLambdaPatched) {
    return
  }

  // Check if we can patch
  if (module?.NodejsFunction) {
    const OriginalNodejsFunction = module.NodejsFunction
    const isLiveMode = process.env.CDK_LIVE === "true"

    // Create wrapper class that captures entry/handler props
    class NodejsFunctionWithCapture extends OriginalNodejsFunction {
      constructor(scope: unknown, id: string, props: NodejsFunctionProps = {}) {
        // In live mode, provide dummy code to skip bundling entirely
        // The aspect will replace this with the bridge code from S3
        let modifiedProps = props
        if (isLiveMode && !props.code && cachedLambdaModule) {
          const dummyCode = createDummyCode(cachedLambdaModule)
          if (dummyCode) {
            modifiedProps = { ...props, code: dummyCode }
          }
        }

        super(scope, id, modifiedProps)

        // Store the entry path on the instance (validate it's a non-empty string)
        if (typeof props.entry === "string" && props.entry.trim().length > 0) {
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

/**
 * Patch DockerImageFunction and DockerImageCode to capture docker context
 */
function patchDockerImageFunction(module: LambdaModule | null): void {
  if (!module) return

  // First, patch DockerImageCode.fromImageAsset to capture the directory path
  if (module.DockerImageCode && !module.DockerImageCode.__liveLambdaPatched) {
    const OriginalDockerImageCode = module.DockerImageCode
    const originalFromImageAsset = OriginalDockerImageCode.fromImageAsset

    // Wrap fromImageAsset to capture the directory
    const patchedFromImageAsset = (
      directory: string,
      props?: DockerImageAssetProps,
    ): DockerImageCodeInstance => {
      const result = originalFromImageAsset.call(
        OriginalDockerImageCode,
        directory,
        props,
      )

      // Store the directory path in the WeakMap, keyed by the result instance
      dockerImageCodeContextMap.set(result as object, directory)

      return result
    }

    try {
      Object.defineProperty(OriginalDockerImageCode, "fromImageAsset", {
        value: patchedFromImageAsset,
        writable: true,
        configurable: true,
      })
      ;(
        OriginalDockerImageCode as DockerImageCodeStatic & {
          __liveLambdaPatched?: boolean
        }
      ).__liveLambdaPatched = true
    } catch (err) {
      console.warn(
        "[LiveLambda] Could not patch DockerImageCode.fromImageAsset:",
        (err as Error).message,
      )
    }
  }

  // Then, patch DockerImageFunction to read from the WeakMap
  if (
    module.DockerImageFunction &&
    !module.DockerImageFunction.__liveLambdaPatched
  ) {
    const OriginalDockerImageFunction = module.DockerImageFunction

    // Create wrapper class that captures docker context
    class DockerImageFunctionWithCapture extends OriginalDockerImageFunction {
      constructor(scope: unknown, id: string, props: DockerImageFunctionProps) {
        super(scope, id, props)

        // Look up the docker context from the WeakMap
        if (props.code) {
          const contextPath = dockerImageCodeContextMap.get(
            props.code as object,
          )
          if (contextPath) {
            ;(this as unknown as Record<symbol, string>)[
              DOCKER_CONTEXT_SYMBOL
            ] = contextPath
          }
        }
      }

      static __liveLambdaPatched = true
    }

    try {
      Object.defineProperty(module, "DockerImageFunction", {
        value: DockerImageFunctionWithCapture,
        writable: true,
        configurable: true,
      })
    } catch (err) {
      console.warn(
        "[LiveLambda] Could not patch DockerImageFunction:",
        (err as Error).message,
      )
    }
  }
}
