/**
 * Docker container management utilities.
 *
 * Handles running Docker containers with the Lambda Runtime API
 * environment configured.
 */

import { spawn } from "node:child_process"
import * as os from "node:os"
import { Effect, type Fiber, Queue } from "effect"
import type {
  DockerRunConfig,
  DockerRunResult,
  DockerRuntimeInfo,
} from "./types.js"

/**
 * Detect the Docker runtime environment.
 */
export const detectDockerRuntime = (): Effect.Effect<
  DockerRuntimeInfo,
  Error
> =>
  Effect.try({
    try: () => {
      const platform = os.platform()
      const isLinux = platform === "linux"
      const isWsl =
        isLinux &&
        (process.env.WSL_DISTRO_NAME !== undefined ||
          process.env.WSL_INTEROP !== undefined)

      // On Mac/Windows Docker Desktop, use host.docker.internal
      // On Linux, we need to use the host's IP or --network=host
      const isDockerDesktop = !isLinux || isWsl

      const hostAddress = isDockerDesktop
        ? "host.docker.internal"
        : "172.17.0.1" // Default Docker bridge gateway

      return {
        dockerPath: "docker",
        isLinux,
        isWsl,
        isDockerDesktop,
        hostAddress,
      }
    },
    catch: (error) =>
      new Error(`Failed to detect Docker runtime: ${String(error)}`),
  })

/**
 * Build Docker run arguments from config.
 */
const buildDockerArgs = (
  config: DockerRunConfig,
  runtime: DockerRuntimeInfo,
): string[] => {
  const args: string[] = ["run", "--rm"]

  // Container name (add timestamp for uniqueness)
  if (config.containerName) {
    args.push("--name", `${config.containerName}-${Date.now()}`)
  }

  // Platform - allow running ARM64 images on x86_64 via QEMU
  if (config.platform) {
    args.push("--platform", config.platform)
  }

  // Memory limit
  args.push("--memory", `${config.memoryMB}m`)

  // Network mode
  if (config.networkMode === "host") {
    args.push("--network", "host")
  } else if (config.networkMode !== "none") {
    // For bridge mode, add host mapping for non-Linux
    if (runtime.isDockerDesktop) {
      // host.docker.internal is automatically available on Docker Desktop
    } else {
      // On Linux, add explicit host mapping and helper address
      args.push("--add-host", `host.docker.internal:${runtime.hostAddress}`)
      args.push("--add-host", `host.containers.internal:${runtime.hostAddress}`)
      args.push("--add-host", `runtime.api:${runtime.hostAddress}`)
    }
  }

  // Extra hosts
  if (config.extraHosts) {
    for (const host of config.extraHosts) {
      args.push("--add-host", host)
    }
  }

  // Environment variables
  for (const [key, value] of Object.entries(config.environment)) {
    args.push("-e", `${key}=${value}`)
  }

  // Working directory
  if (config.workdir) {
    args.push("-w", config.workdir)
  }

  // Additional arguments
  if (config.additionalArgs) {
    args.push(...config.additionalArgs)
  }

  // Image
  args.push(config.imageUri)

  return args
}

/**
 * Run a Docker container and wait for it to complete.
 */
export const runDockerContainer = (
  config: DockerRunConfig,
): Effect.Effect<DockerRunResult, Error> =>
  Effect.gen(function* () {
    const runtime = yield* detectDockerRuntime()
    const args = buildDockerArgs(config, runtime)

    yield* Effect.logInfo(`Running: docker ${args.join(" ")}`)

    const result = yield* Effect.async<DockerRunResult, Error>((resume) => {
      const stdout: string[] = []
      const stderr: string[] = []

      const proc = spawn(runtime.dockerPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString()
        stdout.push(text)
        process.stdout.write(`[Container] ${text}`)
      })

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString()
        stderr.push(text)
        process.stderr.write(`[Container] ${text}`)
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new Error(`Docker process error: ${err.message}`)))
      })

      proc.on("close", (exitCode) => {
        resume(
          Effect.succeed({
            exitCode: exitCode ?? 1,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
          }),
        )
      })

      // Set up timeout
      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM")
        setTimeout(() => proc.kill("SIGKILL"), 5000)
      }, config.timeoutSeconds * 1000)

      proc.on("close", () => clearTimeout(timeoutId))
    })

    if (result.exitCode !== 0) {
      yield* Effect.logWarning(`Container exited with code ${result.exitCode}`)
    }

    return result
  })

/**
 * Run a Docker container in the background and return a fiber that can be interrupted.
 */
export const runDockerContainerFiber = (
  config: DockerRunConfig,
): Effect.Effect<Fiber.RuntimeFiber<DockerRunResult, Error>> =>
  runDockerContainer(config).pipe(Effect.fork)

/**
 * Pull a Docker image if not already present.
 */
export const pullDockerImage = (imageUri: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const runtime = yield* detectDockerRuntime()

    yield* Effect.logInfo(`Pulling image: ${imageUri}`)

    yield* Effect.async<void, Error>((resume) => {
      const proc = spawn(runtime.dockerPath, ["pull", imageUri], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      proc.stdout.on("data", (data: Buffer) => {
        process.stdout.write(`[Docker] ${data.toString()}`)
      })

      proc.stderr.on("data", (data: Buffer) => {
        process.stderr.write(`[Docker] ${data.toString()}`)
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new Error(`Docker pull error: ${err.message}`)))
      })

      proc.on("close", (exitCode) => {
        if (exitCode === 0) {
          resume(Effect.succeed(undefined))
        } else {
          resume(
            Effect.fail(new Error(`Docker pull failed with code ${exitCode}`)),
          )
        }
      })
    })

    yield* Effect.logInfo(`Image pulled: ${imageUri}`)
  })

/**
 * Build a Docker image from a local context directory.
 */
export const buildDockerImage = (options: {
  contextPath: string
  imageName: string
  platform?: string
}): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const runtime = yield* detectDockerRuntime()

    const args = [
      "build",
      "-t",
      options.imageName,
      "--platform",
      options.platform ?? "linux/arm64",
      options.contextPath,
    ]

    yield* Effect.logInfo(`Building image: ${options.imageName}`)
    yield* Effect.logInfo(`Context: ${options.contextPath}`)

    yield* Effect.async<void, Error>((resume) => {
      const proc = spawn(runtime.dockerPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      proc.stdout.on("data", (data: Buffer) => {
        process.stdout.write(`[Docker] ${data.toString()}`)
      })

      proc.stderr.on("data", (data: Buffer) => {
        process.stderr.write(`[Docker] ${data.toString()}`)
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new Error(`Docker build error: ${err.message}`)))
      })

      proc.on("close", (exitCode) => {
        if (exitCode === 0) {
          resume(Effect.succeed(undefined))
        } else {
          resume(
            Effect.fail(new Error(`Docker build failed with code ${exitCode}`)),
          )
        }
      })
    })

    yield* Effect.logInfo(`Image built: ${options.imageName}`)
  })

/**
 * Create a container config for running a Lambda container.
 */
export const makeLambdaContainerConfig = (options: {
  imageUri: string
  runtimeApiHost: string
  runtimeApiPort: number
  functionName: string
  functionVersion: string
  memoryMB: number
  timeoutSeconds: number
  handler?: string
  awsRegion?: string
  platform?: string
  additionalEnv?: Record<string, string>
}): DockerRunConfig => ({
  imageUri: options.imageUri,
  containerName: `lambda-${options.functionName.replace(/[^a-zA-Z0-9]/g, "-")}`,
  platform: options.platform,
  environment: {
    AWS_LAMBDA_RUNTIME_API: `${options.runtimeApiHost}:${options.runtimeApiPort}`,
    AWS_LAMBDA_FUNCTION_NAME: options.functionName,
    AWS_LAMBDA_FUNCTION_VERSION: options.functionVersion,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(options.memoryMB),
    AWS_REGION: options.awsRegion ?? "us-east-1",
    AWS_DEFAULT_REGION: options.awsRegion ?? "us-east-1",
    AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${options.functionName}`,
    AWS_LAMBDA_LOG_STREAM_NAME: "local",
    _HANDLER: options.handler ?? "index.handler",
    ...options.additionalEnv,
  },
  memoryMB: options.memoryMB,
  timeoutSeconds: options.timeoutSeconds,
  networkMode: "bridge",
})

/**
 * Stream output from a Docker container.
 */
export interface ContainerOutput {
  type: "stdout" | "stderr"
  data: string
}

/**
 * Run a Docker container and stream output to a queue.
 */
export const runDockerContainerWithOutput = (
  config: DockerRunConfig,
  outputQueue: Queue.Queue<ContainerOutput>,
): Effect.Effect<DockerRunResult, Error> =>
  Effect.gen(function* () {
    const runtime = yield* detectDockerRuntime()
    const args = buildDockerArgs(config, runtime)

    const result = yield* Effect.async<DockerRunResult, Error>((resume) => {
      const stdout: string[] = []
      const stderr: string[] = []

      const proc = spawn(runtime.dockerPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString()
        stdout.push(text)
        Effect.runSync(Queue.offer(outputQueue, { type: "stdout", data: text }))
      })

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString()
        stderr.push(text)
        Effect.runSync(Queue.offer(outputQueue, { type: "stderr", data: text }))
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new Error(`Docker process error: ${err.message}`)))
      })

      proc.on("close", (exitCode) => {
        resume(
          Effect.succeed({
            exitCode: exitCode ?? 1,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
          }),
        )
      })

      // Set up timeout
      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM")
        setTimeout(() => proc.kill("SIGKILL"), 5000)
      }, config.timeoutSeconds * 1000)

      proc.on("close", () => clearTimeout(timeoutId))
    })

    return result
  })
