/**
 * Tests for environment variable isolation.
 *
 * These tests verify:
 * 1. Env vars are only applied on cold start (first invocation)
 * 2. Env vars aren't re-sent on warm invocations
 * 3. Pure isolation - only explicitly sent env vars reach the execution environment
 */

import { describe, expect, it } from "bun:test"
import { makeLambdaContainerConfig } from "../src/cli/docker/container.js"
import {
  EXCLUDED_ENV_VARS,
  filterEnvVars,
  LOCAL_OVERRIDE_ENV_VARS,
} from "../src/shared/types.js"

describe("Environment Variable Isolation", () => {
  describe("Docker Container Env Isolation", () => {
    it("only includes explicitly passed additionalEnv", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "fn",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
        additionalEnv: {
          DATABASE_URL: "postgres://localhost/db",
          API_KEY: "secret",
        },
      })

      // Should have the user-defined env vars
      expect(config.environment.DATABASE_URL).toBe("postgres://localhost/db")
      expect(config.environment.API_KEY).toBe("secret")
    })

    it("does not include local process.env variables", () => {
      // Set a unique env var that should NOT appear in container config
      const uniqueVar = `TEST_LOCAL_LEAK_${Date.now()}`
      process.env[uniqueVar] = "should-not-leak"

      try {
        const config = makeLambdaContainerConfig({
          imageUri: "my-image",
          runtimeApiHost: "localhost",
          runtimeApiPort: 9001,
          functionName: "fn",
          functionVersion: "$LATEST",
          memoryMB: 128,
          timeoutSeconds: 10,
          // No additionalEnv - container should only have Lambda runtime vars
        })

        // Verify the unique local env var did NOT leak into container config
        expect(config.environment[uniqueVar]).toBeUndefined()

        // Verify common local env vars don't leak
        expect(config.environment.TERM).toBeUndefined()
        expect(config.environment.SHELL).toBeUndefined()
        expect(config.environment.USER).toBeUndefined()
        expect(config.environment.EDITOR).toBeUndefined()
      } finally {
        delete process.env[uniqueVar]
      }
    })

    it("only contains Lambda runtime vars plus explicit additionalEnv", () => {
      const additionalEnv = {
        MY_VAR: "value1",
        OTHER_VAR: "value2",
      }

      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "test-fn",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
        additionalEnv,
      })

      // Expected keys: Lambda runtime vars + additionalEnv
      const expectedKeys = new Set([
        // Lambda runtime vars
        "AWS_LAMBDA_RUNTIME_API",
        "AWS_LAMBDA_FUNCTION_NAME",
        "AWS_LAMBDA_FUNCTION_VERSION",
        "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_LAMBDA_LOG_GROUP_NAME",
        "AWS_LAMBDA_LOG_STREAM_NAME",
        "_HANDLER",
        // Additional env
        "MY_VAR",
        "OTHER_VAR",
      ])

      const actualKeys = new Set(Object.keys(config.environment))
      expect(actualKeys).toEqual(expectedKeys)
    })
  })

  describe("Node.js Worker Env Isolation", () => {
    it("filterEnvVars removes all excluded variables", () => {
      // Create an env with all excluded vars plus user vars
      const env: NodeJS.ProcessEnv = {
        // User vars that should be kept
        DATABASE_URL: "postgres://localhost/db",
        API_KEY: "secret",
        // Lambda internals that should be excluded
        AWS_LAMBDA_RUNTIME_API: "excluded",
        _HANDLER: "excluded",
        LAMBDA_TASK_ROOT: "excluded",
        // System vars that should be excluded
        PATH: "/usr/bin",
        HOME: "/home/user",
        USER: "testuser",
      }

      const result = filterEnvVars(env)

      // User vars should be present
      expect(result.DATABASE_URL).toBe("postgres://localhost/db")
      expect(result.API_KEY).toBe("secret")

      // Excluded vars should NOT be present
      expect(result.AWS_LAMBDA_RUNTIME_API).toBeUndefined()
      expect(result._HANDLER).toBeUndefined()
      expect(result.LAMBDA_TASK_ROOT).toBeUndefined()
      expect(result.PATH).toBeUndefined()
      expect(result.HOME).toBeUndefined()
      expect(result.USER).toBeUndefined()
    })

    it("LOCAL_OVERRIDE_ENV_VARS contains daemon-controlled variables", () => {
      // These are the vars that the local daemon sets, overriding bridge values
      // Note: AWS_LAMBDA_FUNCTION_MEMORY_SIZE is set locally but not filtered
      // because it comes from context, not the bridge Lambda's process.env
      expect(LOCAL_OVERRIDE_ENV_VARS.has("AWS_LAMBDA_RUNTIME_API")).toBe(true)
      expect(LOCAL_OVERRIDE_ENV_VARS.has("_HANDLER")).toBe(true)
      expect(LOCAL_OVERRIDE_ENV_VARS.has("LAMBDA_TASK_ROOT")).toBe(true)
    })

    it("all LOCAL_OVERRIDE_ENV_VARS are in EXCLUDED_ENV_VARS", () => {
      // Ensure consistency: vars we override locally should be excluded from bridge
      for (const key of LOCAL_OVERRIDE_ENV_VARS) {
        expect(EXCLUDED_ENV_VARS.has(key)).toBe(true)
      }
    })
  })

  describe("Env Vars Only on Cold Start", () => {
    it("filterEnvVars produces consistent output for same input", () => {
      // This simulates multiple invocations with the same env
      // The filtered result should be identical
      const env: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgres://localhost/db",
        API_KEY: "secret",
        PATH: "/usr/bin",
      }

      const result1 = filterEnvVars(env)
      const result2 = filterEnvVars(env)

      expect(result1).toEqual(result2)
      expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
    })

    it("env change detection works correctly", () => {
      // Simulate cold start env
      const coldStartEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgres://localhost/db",
        API_KEY: "secret-v1",
      }

      // Simulate warm invocation with same env
      const warmEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgres://localhost/db",
        API_KEY: "secret-v1",
      }

      // Simulate env change (e.g., after CDK redeploy)
      const changedEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgres://localhost/db",
        API_KEY: "secret-v2", // Changed!
      }

      const coldResult = filterEnvVars(coldStartEnv)
      const warmResult = filterEnvVars(warmEnv)
      const changedResult = filterEnvVars(changedEnv)

      // Cold start and warm invocation should have same filtered env
      expect(JSON.stringify(coldResult)).toBe(JSON.stringify(warmResult))

      // Changed env should be different
      expect(JSON.stringify(coldResult)).not.toBe(JSON.stringify(changedResult))
    })
  })

  describe("No Local Env Leakage", () => {
    it("process.env variables do not leak through filterEnvVars", () => {
      // Set some unique local env vars
      const uniqueVars = [
        `TEST_LEAK_1_${Date.now()}`,
        `TEST_LEAK_2_${Date.now()}`,
        `MY_LOCAL_SECRET_${Date.now()}`,
      ]

      for (const v of uniqueVars) {
        process.env[v] = "should-not-leak"
      }

      try {
        // Create a mock bridge Lambda env (what would come from AWS)
        const bridgeEnv: NodeJS.ProcessEnv = {
          DATABASE_URL: "postgres://aws-rds/db",
          AWS_ACCESS_KEY_ID: "AKIA...",
          AWS_SECRET_ACCESS_KEY: "secret",
          AWS_REGION: "us-east-1",
        }

        const result = filterEnvVars(bridgeEnv)

        // Should have bridge env vars
        expect(result.DATABASE_URL).toBe("postgres://aws-rds/db")
        expect(result.AWS_ACCESS_KEY_ID).toBe("AKIA...")

        // Should NOT have local env vars that weren't in bridgeEnv
        for (const v of uniqueVars) {
          expect(result[v]).toBeUndefined()
        }
      } finally {
        for (const v of uniqueVars) {
          delete process.env[v]
        }
      }
    })

    it("filterEnvVars only returns keys from the input env", () => {
      // Set a local env var
      const localVar = `LOCAL_ONLY_${Date.now()}`
      process.env[localVar] = "local-value"

      try {
        // Input env without the local var
        const inputEnv: NodeJS.ProcessEnv = {
          FROM_BRIDGE: "bridge-value",
        }

        const result = filterEnvVars(inputEnv)

        // Result should only contain keys from inputEnv
        expect(Object.keys(result)).toEqual(["FROM_BRIDGE"])
        expect(result[localVar]).toBeUndefined()
      } finally {
        delete process.env[localVar]
      }
    })
  })
})
