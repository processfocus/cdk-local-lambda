/**
 * Tests for Docker service.
 *
 * These tests verify:
 * 1. Runtime detection logic
 * 2. Container configuration generation
 * 3. Docker command execution (when Docker is available)
 */

import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  Docker,
  DockerLive,
  detectDockerRuntime,
  makeLambdaContainerConfig,
} from "../src/cli/docker/container.js"

// Docker operations can be slow
setDefaultTimeout(60_000)

/**
 * Check if Docker is available on the system.
 */
const isDockerAvailable = async (): Promise<boolean> => {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

let dockerAvailable = false

beforeAll(async () => {
  dockerAvailable = await isDockerAvailable()
  if (!dockerAvailable) {
    console.log("Docker not available - skipping Docker integration tests")
  }
})

describe("Docker Service", () => {
  describe("detectDockerRuntime", () => {
    it("detects runtime environment", async () => {
      const result = await Effect.runPromise(detectDockerRuntime())

      expect(result).toHaveProperty("dockerPath")
      expect(result).toHaveProperty("isLinux")
      expect(result).toHaveProperty("isWsl")
      expect(result).toHaveProperty("isDockerDesktop")
      expect(result).toHaveProperty("hostAddress")

      // dockerPath should be "docker"
      expect(result.dockerPath).toBe("docker")

      // hostAddress should be a valid value
      expect(
        result.hostAddress === "host.docker.internal" ||
          result.hostAddress === "172.17.0.1",
      ).toBe(true)
    })

    it("returns consistent runtime info", async () => {
      const result1 = await Effect.runPromise(detectDockerRuntime())
      const result2 = await Effect.runPromise(detectDockerRuntime())

      expect(result1).toEqual(result2)
    })
  })

  describe("makeLambdaContainerConfig", () => {
    it("creates config with required fields", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image:latest",
        runtimeApiHost: "host.docker.internal",
        runtimeApiPort: 9001,
        functionName: "my-function",
        functionVersion: "$LATEST",
        memoryMB: 256,
        timeoutSeconds: 30,
      })

      expect(config.imageUri).toBe("my-image:latest")
      expect(config.memoryMB).toBe(256)
      expect(config.timeoutSeconds).toBe(30)
      expect(config.networkMode).toBe("bridge")
      expect(config.containerName).toBe("lambda-my-function")
    })

    it("sets environment variables correctly", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image:latest",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "test-fn",
        functionVersion: "1",
        memoryMB: 128,
        timeoutSeconds: 10,
        handler: "index.myHandler",
        awsRegion: "eu-west-1",
      })

      expect(config.environment.AWS_LAMBDA_RUNTIME_API).toBe("localhost:9001")
      expect(config.environment.AWS_LAMBDA_FUNCTION_NAME).toBe("test-fn")
      expect(config.environment.AWS_LAMBDA_FUNCTION_VERSION).toBe("1")
      expect(config.environment.AWS_LAMBDA_FUNCTION_MEMORY_SIZE).toBe("128")
      expect(config.environment._HANDLER).toBe("index.myHandler")
      expect(config.environment.AWS_REGION).toBe("eu-west-1")
    })

    it("uses default handler and region", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "fn",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
      })

      expect(config.environment._HANDLER).toBe("index.handler")
      expect(config.environment.AWS_REGION).toBe("us-east-1")
    })

    it("includes platform when specified", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "fn",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
        platform: "linux/arm64",
      })

      expect(config.platform).toBe("linux/arm64")
    })

    it("includes additional environment variables", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "fn",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
        additionalEnv: {
          MY_VAR: "my-value",
          ANOTHER_VAR: "another-value",
        },
      })

      expect(config.environment.MY_VAR).toBe("my-value")
      expect(config.environment.ANOTHER_VAR).toBe("another-value")
    })

    it("sanitizes function name in container name", () => {
      const config = makeLambdaContainerConfig({
        imageUri: "my-image",
        runtimeApiHost: "localhost",
        runtimeApiPort: 9001,
        functionName: "my-stack_my-function.handler",
        functionVersion: "$LATEST",
        memoryMB: 128,
        timeoutSeconds: 10,
      })

      // Special characters should be replaced with dashes
      expect(config.containerName).toBe("lambda-my-stack-my-function-handler")
    })
  })

  describe("Docker Service Layer", () => {
    it("can be created and provides getRuntimeInfo", async () => {
      const program = Effect.gen(function* () {
        const docker = yield* Docker
        const info = yield* docker.getRuntimeInfo()
        return info
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(DockerLive),
          Effect.provide(BunContext.layer),
        ),
      )

      expect(result).toHaveProperty("dockerPath")
      expect(result).toHaveProperty("isDockerDesktop")
    })
  })

  describe("Docker Service Integration", () => {
    it("can list containers (empty filter)", async () => {
      if (!dockerAvailable) {
        console.log("Skipping: Docker not available")
        return
      }

      const program = Effect.gen(function* () {
        const docker = yield* Docker
        // Use a filter that shouldn't match anything
        const containers = yield* docker
          .list("nonexistent-container-12345")
          .pipe(Effect.scoped)
        return containers
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(DockerLive),
          Effect.provide(BunContext.layer),
        ),
      )

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(0)
    })

    it("can attempt to stop non-existent containers gracefully", async () => {
      if (!dockerAvailable) {
        console.log("Skipping: Docker not available")
        return
      }

      const program = Effect.gen(function* () {
        const docker = yield* Docker
        // Stop with a filter that won't match anything
        const count = yield* docker
          .stop("nonexistent-container-12345")
          .pipe(Effect.scoped)
        return count
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(DockerLive),
          Effect.provide(BunContext.layer),
        ),
      )

      expect(result).toBe(0) // No containers stopped
    })

    it("can pull a small test image", async () => {
      if (!dockerAvailable) {
        console.log("Skipping: Docker not available")
        return
      }

      const program = Effect.gen(function* () {
        const docker = yield* Docker
        // Pull a very small image for testing
        yield* docker.pull("hello-world:latest").pipe(Effect.scoped)
      })

      // This should not throw
      await Effect.runPromise(
        program.pipe(
          Effect.provide(DockerLive),
          Effect.provide(BunContext.layer),
        ),
      )
    })

    it("can run a simple container", async () => {
      if (!dockerAvailable) {
        console.log("Skipping: Docker not available")
        return
      }

      const program = Effect.gen(function* () {
        const docker = yield* Docker

        const result = yield* docker
          .run({
            imageUri: "hello-world:latest",
            memoryMB: 64,
            timeoutSeconds: 30,
            environment: {},
            networkMode: "bridge",
          })
          .pipe(Effect.scoped)

        return result
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(DockerLive),
          Effect.provide(BunContext.layer),
        ),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Hello from Docker")
    })
  })
})
