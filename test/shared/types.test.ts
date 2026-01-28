/**
 * Unit tests for shared types and utility functions.
 */

import { describe, expect, it } from "bun:test"
import {
  buildChannelName,
  EXCLUDED_ENV_VARS,
  filterEnvVars,
  hashFunctionName,
} from "../../src/shared/types.js"

describe("hashFunctionName", () => {
  it("returns 16 hex characters", () => {
    const hash = hashFunctionName("my-function")
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })

  it("is deterministic", () => {
    const hash1 = hashFunctionName("my-function")
    const hash2 = hashFunctionName("my-function")
    expect(hash1).toBe(hash2)
  })

  it("produces different hashes for different inputs", () => {
    const hash1 = hashFunctionName("function-a")
    const hash2 = hashFunctionName("function-b")
    expect(hash1).not.toBe(hash2)
  })

  it("handles long function names", () => {
    const longName = "a".repeat(256)
    const hash = hashFunctionName(longName)
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })

  it("handles special characters", () => {
    const hash = hashFunctionName("my-function_v2:latest")
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })
})

describe("buildChannelName", () => {
  describe("invocation", () => {
    it("returns correct path structure", () => {
      const channel = buildChannelName.invocation("my-function")
      expect(channel).toMatch(/^\/live\/[a-f0-9]{16}\/in$/)
    })

    it("uses hashed function name", () => {
      const channel = buildChannelName.invocation("my-function")
      const expectedHash = hashFunctionName("my-function")
      expect(channel).toBe(`/live/${expectedHash}/in`)
    })

    it("produces different channels for different functions", () => {
      const channel1 = buildChannelName.invocation("function-a")
      const channel2 = buildChannelName.invocation("function-b")
      expect(channel1).not.toBe(channel2)
    })
  })

  describe("response", () => {
    it("returns correct path structure", () => {
      const channel = buildChannelName.response("my-function")
      expect(channel).toMatch(/^\/live\/[a-f0-9]{16}\/out$/)
    })

    it("uses hashed function name", () => {
      const channel = buildChannelName.response("my-function")
      const expectedHash = hashFunctionName("my-function")
      expect(channel).toBe(`/live/${expectedHash}/out`)
    })

    it("produces different channels for different functions", () => {
      const channel1 = buildChannelName.response("function-a")
      const channel2 = buildChannelName.response("function-b")
      expect(channel1).not.toBe(channel2)
    })
  })

  it("invocation and response use same hash for same function", () => {
    const invocationChannel = buildChannelName.invocation("my-function")
    const responseChannel = buildChannelName.response("my-function")
    const hash = hashFunctionName("my-function")
    expect(invocationChannel).toContain(hash)
    expect(responseChannel).toContain(hash)
  })
})

describe("filterEnvVars", () => {
  it("excludes Lambda runtime internals", () => {
    const env: NodeJS.ProcessEnv = {
      MY_VAR: "value",
      AWS_LAMBDA_RUNTIME_API: "should-be-excluded",
      _HANDLER: "should-be-excluded",
      LAMBDA_TASK_ROOT: "should-be-excluded",
      AWS_LAMBDA_INITIALIZATION_TYPE: "should-be-excluded",
      AWS_EXECUTION_ENV: "should-be-excluded",
      LAMBDA_RUNTIME_DIR: "should-be-excluded",
    }
    const result = filterEnvVars(env)
    expect(result.MY_VAR).toBe("value")
    expect(result.AWS_LAMBDA_RUNTIME_API).toBeUndefined()
    expect(result._HANDLER).toBeUndefined()
    expect(result.LAMBDA_TASK_ROOT).toBeUndefined()
    expect(result.AWS_LAMBDA_INITIALIZATION_TYPE).toBeUndefined()
    expect(result.AWS_EXECUTION_ENV).toBeUndefined()
    expect(result.LAMBDA_RUNTIME_DIR).toBeUndefined()
  })

  it("excludes Lambda internal socket variables", () => {
    const env: NodeJS.ProcessEnv = {
      MY_VAR: "value",
      _LAMBDA_CONSOLE_SOCKET: "should-be-excluded",
      _LAMBDA_CONTROL_SOCKET: "should-be-excluded",
      _LAMBDA_LOG_FD: "should-be-excluded",
      _LAMBDA_SHARED_MEM_FD: "should-be-excluded",
      _LAMBDA_RUNTIME_LOAD_TIME: "should-be-excluded",
      _LAMBDA_SB_ID: "should-be-excluded",
      _LAMBDA_SERVER_PORT: "should-be-excluded",
    }
    const result = filterEnvVars(env)
    expect(result.MY_VAR).toBe("value")
    expect(result._LAMBDA_CONSOLE_SOCKET).toBeUndefined()
    expect(result._LAMBDA_CONTROL_SOCKET).toBeUndefined()
    expect(result._LAMBDA_LOG_FD).toBeUndefined()
  })

  it("excludes X-Ray variables", () => {
    const env: NodeJS.ProcessEnv = {
      MY_VAR: "value",
      AWS_XRAY_DAEMON_ADDRESS: "should-be-excluded",
      AWS_XRAY_CONTEXT_MISSING: "should-be-excluded",
      _X_AMZN_TRACE_ID: "should-be-excluded",
    }
    const result = filterEnvVars(env)
    expect(result.MY_VAR).toBe("value")
    expect(result.AWS_XRAY_DAEMON_ADDRESS).toBeUndefined()
    expect(result.AWS_XRAY_CONTEXT_MISSING).toBeUndefined()
    expect(result._X_AMZN_TRACE_ID).toBeUndefined()
  })

  it("excludes system variables that should use local values", () => {
    const env: NodeJS.ProcessEnv = {
      MY_VAR: "value",
      PATH: "/usr/bin",
      PWD: "/some/path",
      HOME: "/home/user",
      USER: "testuser",
      SHELL: "/bin/bash",
      SHLVL: "1",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LD_LIBRARY_PATH: "/lib",
      TZ: "UTC",
    }
    const result = filterEnvVars(env)
    expect(result.MY_VAR).toBe("value")
    expect(result.PATH).toBeUndefined()
    expect(result.PWD).toBeUndefined()
    expect(result.HOME).toBeUndefined()
    expect(result.USER).toBeUndefined()
    expect(result.SHELL).toBeUndefined()
    expect(result.TZ).toBeUndefined()
  })

  it("includes user-defined environment variables", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://localhost:5432/db",
      API_KEY: "secret-key-123",
      DEBUG: "true",
      NODE_ENV: "development",
      MY_CUSTOM_VAR: "custom-value",
    }
    const result = filterEnvVars(env)
    expect(result.DATABASE_URL).toBe("postgres://localhost:5432/db")
    expect(result.API_KEY).toBe("secret-key-123")
    expect(result.DEBUG).toBe("true")
    expect(result.NODE_ENV).toBe("development")
    expect(result.MY_CUSTOM_VAR).toBe("custom-value")
  })

  it("includes AWS credentials and region", () => {
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_SESSION_TOKEN: "session-token",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
    }
    const result = filterEnvVars(env)
    expect(result.AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE")
    expect(result.AWS_SECRET_ACCESS_KEY).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    )
    expect(result.AWS_SESSION_TOKEN).toBe("session-token")
    expect(result.AWS_REGION).toBe("us-east-1")
  })

  it("excludes undefined values", () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: "yes",
      UNDEFINED: undefined,
    }
    const result = filterEnvVars(env)
    expect(result.DEFINED).toBe("yes")
    expect("UNDEFINED" in result).toBe(false)
  })

  it("returns empty object for env with only excluded vars", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      _HANDLER: "index.handler",
    }
    const result = filterEnvVars(env)
    expect(Object.keys(result)).toHaveLength(0)
  })

  it("EXCLUDED_ENV_VARS contains all expected Lambda internals", () => {
    // Verify the exclusion list contains critical Lambda internals
    expect(EXCLUDED_ENV_VARS.has("AWS_LAMBDA_RUNTIME_API")).toBe(true)
    expect(EXCLUDED_ENV_VARS.has("_HANDLER")).toBe(true)
    expect(EXCLUDED_ENV_VARS.has("LAMBDA_TASK_ROOT")).toBe(true)
    expect(EXCLUDED_ENV_VARS.has("PATH")).toBe(true)
    expect(EXCLUDED_ENV_VARS.has("HOME")).toBe(true)
  })
})
