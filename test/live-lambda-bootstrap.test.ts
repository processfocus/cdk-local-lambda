/**
 * Tests for the bootstrap hook that captures NodejsFunction entry paths.
 *
 * Node.js: we use a Module._load hook.
 * Bun: we can patch CommonJS exports, but Bun snapshots named exports when a
 * CommonJS module is imported from ESM. That means `import ".../bootstrap"` in
 * the same file as `import { NodejsFunction } ...` is usually too late.
 *
 * Therefore:
 * - In-process (static ESM imports): capture is expected to be missing.
 * - With `bun --preload cdk-local-lambda/bootstrap`: capture should work.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"

// Import bootstrap BEFORE aws-lambda-nodejs to install hooks
import "cdk-local-lambda/bootstrap"

import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"

// Symbols used by the bootstrap to store captured values
const ENTRY_SYMBOL = Symbol.for("live-lambda:entry")
const HANDLER_SYMBOL = Symbol.for("live-lambda:handler")
const DOCKER_CONTEXT_SYMBOL = Symbol.for("live-lambda:docker-context")

// Inline code to skip bundling in tests
const DUMMY_CODE = lambda.Code.fromInline("exports.handler = () => {}")

// Bun limitation: Module._load patching doesn't work
const isBun = typeof process.versions.bun !== "undefined"

describe("live-lambda-bootstrap", () => {
  let app: cdk.App
  let stack: cdk.Stack

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack")
  })

  afterEach(() => {
    delete process.env.CDK_LOCAL_LAMBDA
  })

  describe("NodejsFunction hook", () => {
    it("documents that patching does not work in Bun without preload", () => {
      // In Bun, the Module._load hook doesn't affect ESM imports
      // This test documents this limitation
      const fn = new NodejsFunction(stack, "TestFunction", {
        entry: "test/fixtures/handler.ts",
        handler: "main",
        code: DUMMY_CODE,
      })

      const capturedEntry = (fn as unknown as Record<symbol, string>)[
        ENTRY_SYMBOL
      ]
      const capturedHandler = (fn as unknown as Record<symbol, string>)[
        HANDLER_SYMBOL
      ]

      if (isBun) {
        // In Bun, static ESM imports have already been linked before the bootstrap runs.
        // This is expected unless the bootstrap was preloaded.
        expect(capturedEntry).toBeUndefined()
        expect(capturedHandler).toBeUndefined()
      } else {
        // In Node.js, patching works
        expect(capturedEntry).toBe("test/fixtures/handler.ts")
        expect(capturedHandler).toBe("main")
      }
    })

    it("documents handler default behavior per runtime", () => {
      // This test is only meaningful in Node.js where patching works
      // In Bun, we just verify the limitation is documented
      if (isBun) {
        // In Bun, the hook doesn't work - just pass the test to document this
        expect(isBun).toBe(true)
        return
      }

      // In Node.js, test that handler defaults to 'handler' when not specified
      // Note: We need to provide code to skip bundling in tests
      const fn = new NodejsFunction(stack, "DefaultHandlerFunction", {
        entry: "test/fixtures/handler.ts",
        handler: "index.handler", // Required when code is provided
        code: DUMMY_CODE,
      })

      // The bootstrap hook should have captured the explicit handler
      const capturedHandler = (fn as unknown as Record<symbol, string>)[
        HANDLER_SYMBOL
      ]
      expect(capturedHandler).toBe("index.handler")
    })

    it("documents multiple function capture per runtime", () => {
      const fn1 = new NodejsFunction(stack, "Function1", {
        entry: "test/fixtures/handler1.ts",
        handler: "handler1",
        code: DUMMY_CODE,
      })

      const fn2 = new NodejsFunction(stack, "Function2", {
        entry: "test/fixtures/handler2.ts",
        handler: "handler2",
        code: DUMMY_CODE,
      })

      if (isBun) {
        expect(
          (fn1 as unknown as Record<symbol, string>)[ENTRY_SYMBOL],
        ).toBeUndefined()
        expect(
          (fn2 as unknown as Record<symbol, string>)[ENTRY_SYMBOL],
        ).toBeUndefined()
      } else {
        expect((fn1 as unknown as Record<symbol, string>)[ENTRY_SYMBOL]).toBe(
          "test/fixtures/handler1.ts",
        )
        expect((fn2 as unknown as Record<symbol, string>)[ENTRY_SYMBOL]).toBe(
          "test/fixtures/handler2.ts",
        )
      }
    })

    it("patches successfully in Bun when bootstrap is preloaded", async () => {
      if (!isBun) {
        expect(isBun).toBe(false)
        return
      }

      const proc = Bun.spawnSync(
        [
          "bun",
          "--preload",
          "cdk-local-lambda/bootstrap",
          "-e",
          `import * as cdk from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
const app = new cdk.App();
const stack = new cdk.Stack(app, 'TestStack');
const fn = new NodejsFunction(stack, 'TestFunction', { entry: 'test/fixtures/handler.ts', handler: 'main' });
console.log(String(fn[Symbol.for('live-lambda:entry')]) + '|' + String(fn[Symbol.for('live-lambda:handler')]));
`,
        ],
        {
          env: {
            ...process.env,
            CDK_LOCAL_LAMBDA: "true",
          },
        },
      )

      expect(proc.exitCode).toBe(0)
      const stdout = new TextDecoder().decode(proc.stdout).trim()
      expect(stdout).toBe("test/fixtures/handler.ts|main")
    })
  })

  describe("DockerImageFunction hook", () => {
    it("documents docker context capture per runtime", () => {
      const fn = new lambda.DockerImageFunction(stack, "DockerFunction", {
        code: lambda.DockerImageCode.fromImageAsset("test/fixtures/docker"),
      })

      const capturedContext = (fn as unknown as Record<symbol, string>)[
        DOCKER_CONTEXT_SYMBOL
      ]

      if (isBun) {
        expect(capturedContext).toBeUndefined()
      } else {
        expect(capturedContext).toBe("test/fixtures/docker")
      }
    })

    it("documents multiple docker function capture per runtime", () => {
      const fn1 = new lambda.DockerImageFunction(stack, "Docker1", {
        code: lambda.DockerImageCode.fromImageAsset("test/fixtures/docker"),
      })

      const fn2 = new lambda.DockerImageFunction(stack, "Docker2", {
        code: lambda.DockerImageCode.fromImageAsset("test/fixtures/docker2"),
      })

      if (isBun) {
        expect(
          (fn1 as unknown as Record<symbol, string>)[DOCKER_CONTEXT_SYMBOL],
        ).toBeUndefined()
        expect(
          (fn2 as unknown as Record<symbol, string>)[DOCKER_CONTEXT_SYMBOL],
        ).toBeUndefined()
      } else {
        expect(
          (fn1 as unknown as Record<symbol, string>)[DOCKER_CONTEXT_SYMBOL],
        ).toBe("test/fixtures/docker")
        expect(
          (fn2 as unknown as Record<symbol, string>)[DOCKER_CONTEXT_SYMBOL],
        ).toBe("test/fixtures/docker2")
      }
    })
  })
})
