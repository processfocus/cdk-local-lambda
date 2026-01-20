import { afterEach, beforeEach, describe, expect, it, test } from "bun:test"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { isLiveModeEnabled, LiveLambdaAspect } from "../src"

test("isLiveModeEnabled returns false when CDK_LIVE is not set", () => {
  delete process.env.CDK_LIVE
  expect(isLiveModeEnabled()).toBe(false)
})

test("isLiveModeEnabled returns true when CDK_LIVE is true", () => {
  process.env.CDK_LIVE = "true"
  expect(isLiveModeEnabled()).toBe(true)
  delete process.env.CDK_LIVE
})

test("LiveLambdaAspect can be instantiated", () => {
  const aspect = new LiveLambdaAspect()
  expect(aspect).toBeInstanceOf(LiveLambdaAspect)
})

describe("LiveLambdaAspect property preservation", () => {
  let app: cdk.App
  let stack: cdk.Stack

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack")
  })

  afterEach(() => {
    delete process.env.CDK_LIVE
  })

  describe("preserves lambda package type", () => {
    it("keeps zip functions as zip (does not convert to docker)", () => {
      const fn = new lambda.Function(stack, "ZipFunction", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
        architecture: lambda.Architecture.X86_64,
      })

      const aspect = new LiveLambdaAspect({
        handlerMappings: { ZipFunction: "src/handler.handler" },
      })
      cdk.Aspects.of(stack).add(aspect)

      // Force aspect application by preparing for synthesis
      app.synth({ force: true, validateOnSynthesis: false })

      const cfnFn = fn.node.defaultChild as lambda.CfnFunction
      const code = cfnFn.code as {
        s3Bucket?: unknown
        s3Key?: unknown
        imageUri?: unknown
      }

      // Zip functions should have s3Bucket/s3Key, NOT imageUri
      expect(code.s3Bucket).toBeDefined()
      expect(code.s3Key).toBeDefined()
      expect(code.imageUri).toBeUndefined()
    })

    it("keeps docker functions as docker (does not convert to zip)", () => {
      const fn = new lambda.DockerImageFunction(stack, "DockerFunction", {
        code: lambda.DockerImageCode.fromImageAsset("test/fixtures/docker"),
        architecture: lambda.Architecture.X86_64,
      })

      const aspect = new LiveLambdaAspect()
      cdk.Aspects.of(stack).add(aspect)

      // Force aspect application
      app.synth({ force: true, validateOnSynthesis: false })

      const cfnFn = fn.node.defaultChild as lambda.CfnFunction
      const code = cfnFn.code as {
        s3Bucket?: unknown
        s3Key?: unknown
        imageUri?: unknown
      }

      // Docker functions should have imageUri, NOT s3Bucket/s3Key
      expect(code.imageUri).toBeDefined()
      expect(code.s3Bucket).toBeUndefined()
      expect(code.s3Key).toBeUndefined()
    })
  })

  describe("preserves architecture", () => {
    it("preserves x86_64 architecture", () => {
      const fn = new lambda.Function(stack, "X86Function", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
        architecture: lambda.Architecture.X86_64,
      })

      const aspect = new LiveLambdaAspect({
        handlerMappings: { X86Function: "src/handler.handler" },
      })
      cdk.Aspects.of(stack).add(aspect)

      app.synth({ force: true, validateOnSynthesis: false })

      const cfnFn = fn.node.defaultChild as lambda.CfnFunction
      const architectures = cfnFn.architectures as string[] | undefined

      // Architecture should be x86_64 or undefined (which defaults to x86_64)
      expect(
        architectures === undefined || architectures.includes("x86_64"),
      ).toBe(true)
      expect(architectures?.includes("arm64")).toBeFalsy()
    })

    it("preserves arm64 architecture", () => {
      const fn = new lambda.Function(stack, "ArmFunction", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
        architecture: lambda.Architecture.ARM_64,
      })

      const aspect = new LiveLambdaAspect({
        handlerMappings: { ArmFunction: "src/handler.handler" },
      })
      cdk.Aspects.of(stack).add(aspect)

      app.synth({ force: true, validateOnSynthesis: false })

      const cfnFn = fn.node.defaultChild as lambda.CfnFunction
      const architectures = cfnFn.architectures as string[] | undefined

      expect(architectures).toContain("arm64")
    })
  })

  describe("preserves environment variables", () => {
    it("preserves existing environment variables", () => {
      new lambda.Function(stack, "EnvFunction", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
        environment: {
          MY_VAR: "my-value",
          ANOTHER_VAR: "another-value",
        },
      })

      const aspect = new LiveLambdaAspect({
        handlerMappings: { EnvFunction: "src/handler.handler" },
      })
      cdk.Aspects.of(stack).add(aspect)

      // Use synthesized template to check resolved environment variables
      const assembly = app.synth({ force: true, validateOnSynthesis: false })
      const template = assembly.getStackArtifact("TestStack").template
      const fnResource = Object.values(template.Resources).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.Type === "AWS::Lambda::Function",
      ) as {
        Properties: { Environment?: { Variables?: Record<string, string> } }
      }

      expect(fnResource.Properties.Environment?.Variables?.MY_VAR).toBe(
        "my-value",
      )
      expect(fnResource.Properties.Environment?.Variables?.ANOTHER_VAR).toBe(
        "another-value",
      )
    })

    it("does not add unexpected environment variables", () => {
      new lambda.Function(stack, "NoEnvFunction", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
      })

      const aspect = new LiveLambdaAspect({
        handlerMappings: { NoEnvFunction: "src/handler.handler" },
      })
      cdk.Aspects.of(stack).add(aspect)

      // Use synthesized template to check resolved environment variables
      const assembly = app.synth({ force: true, validateOnSynthesis: false })
      const template = assembly.getStackArtifact("TestStack").template
      const fnResource = Object.values(template.Resources).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.Type === "AWS::Lambda::Function",
      ) as {
        Properties: { Environment?: { Variables?: Record<string, string> } }
      }

      // Should either be undefined or empty (no live-lambda-specific env vars)
      const vars = fnResource.Properties.Environment?.Variables || {}
      const liveVars = Object.keys(vars).filter((k) =>
        k.toLowerCase().includes("live"),
      )
      expect(liveVars).toHaveLength(0)
    })
  })
})
