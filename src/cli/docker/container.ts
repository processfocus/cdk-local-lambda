/**
 * Docker container management utilities.
 *
 * Handles running Docker containers with the Lambda Runtime API
 * environment configured. Uses @effect/platform Command for
 * proper Effect-based process management.
 */

import * as os from "node:os"
import {
  type CommandExecutor,
  Command as PlatformCommand,
} from "@effect/platform"
import type { Process as EffectProcess } from "@effect/platform/CommandExecutor"
import { Context, Effect, Layer, type Scope, Stream } from "effect"
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
const buildDockerRunArgs = (
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
 * Docker Service interface for Effect-based Docker operations.
 * All scoped operations require both Scope and CommandExecutor.
 */
export interface DockerService {
  /**
   * Run a Docker container and wait for it to complete.
   * Output is streamed to stdout/stderr.
   */
  readonly run: (
    config: DockerRunConfig,
  ) => Effect.Effect<
    DockerRunResult,
    Error,
    Scope.Scope | CommandExecutor.CommandExecutor
  >

  /**
   * Run a Docker container with scoped lifecycle management.
   * Returns the running process which can be interrupted via scope.
   */
  readonly runScoped: (
    config: DockerRunConfig,
  ) => Effect.Effect<
    EffectProcess,
    Error,
    Scope.Scope | CommandExecutor.CommandExecutor
  >

  /**
   * Build a Docker image from a local context directory.
   */
  readonly build: (options: {
    contextPath: string
    imageName: string
    platform?: string
  }) => Effect.Effect<
    void,
    Error,
    Scope.Scope | CommandExecutor.CommandExecutor
  >

  /**
   * Pull a Docker image if not already present.
   */
  readonly pull: (
    imageUri: string,
  ) => Effect.Effect<void, Error, Scope.Scope | CommandExecutor.CommandExecutor>

  /**
   * Stop Docker containers matching a name filter.
   * Returns the number of containers stopped.
   */
  readonly stop: (
    containerNameFilter: string,
  ) => Effect.Effect<
    number,
    Error,
    Scope.Scope | CommandExecutor.CommandExecutor
  >

  /**
   * List Docker container IDs matching a name filter.
   */
  readonly list: (
    containerNameFilter: string,
  ) => Effect.Effect<
    string[],
    Error,
    Scope.Scope | CommandExecutor.CommandExecutor
  >

  /**
   * Get the detected Docker runtime info.
   */
  readonly getRuntimeInfo: () => Effect.Effect<DockerRuntimeInfo, Error>
}

/**
 * Docker Service tag for dependency injection.
 */
export class Docker extends Context.Tag("Docker")<Docker, DockerService>() {}

/**
 * Create the live Docker service implementation.
 */
const makeDockerService: Effect.Effect<DockerService, Error> = Effect.gen(
  function* () {
    const runtime = yield* detectDockerRuntime()

    const getRuntimeInfo: DockerService["getRuntimeInfo"] = () =>
      Effect.succeed(runtime)

    const run: DockerService["run"] = (config) =>
      Effect.gen(function* () {
        const args = buildDockerRunArgs(config, runtime)

        yield* Effect.logDebug(`Running: docker ${args.join(" ")}`)

        const command = PlatformCommand.make(runtime.dockerPath, ...args)

        const stdout: string[] = []
        const stderr: string[] = []

        // Run the command and collect output
        const proc = yield* PlatformCommand.start(command)

        // Lambda RIC error/output patterns that are expected during poll timeout
        // These are suppressed from output to avoid scary error messages
        const isExpectedRicOutput = (line: string): boolean =>
          line.includes("LAMBDA_RUNTIME Failed to get next invocation") ||
          line.includes("Failed to get next invocation, error 503") ||
          // Filter out the Node.js stack trace from Lambda RIC exit
          line.includes("triggerUncaughtException") ||
          line.includes("[Error: Failed to get next invocation") ||
          // "Node.js v" version line after error
          line.startsWith("Node.js v") ||
          line.includes("node:internal/process/promises") ||
          // Stack trace caret line (just whitespace and ^)
          /^\s*\^?\s*$/.test(line)

        // Pattern to parse Lambda log format: TIMESTAMP\tREQUEST_ID\tLEVEL\tMESSAGE
        // Lambda uses tabs between fields. Captures: [1] = request ID, [2] = level + message
        const lambdaLogPattern =
          /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)[\t\s]+([0-9a-f-]{36})[\t\s]+(.*)$/i

        // Helper to format log line with invocation prefix
        const formatLine = (
          rawLine: string,
        ): { prefix: string; content: string } => {
          // Strip carriage returns that can cause terminal corruption
          const line = rawLine.replace(/\r/g, "")
          const match = lambdaLogPattern.exec(line)
          if (match && config.invocationContexts) {
            const requestId = match[2]
            const ctx = config.invocationContexts.get(requestId)
            if (ctx) {
              // Strip timestamp and request ID, keep just LEVEL MESSAGE
              return { prefix: `[${ctx.num}]`, content: match[3] }
            }
          }
          return { prefix: "[Container]", content: line }
        }

        // Process stdout - filter expected errors, forward the rest
        const stdoutFiber = yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((rawLine) =>
            Effect.sync(() => {
              stdout.push(rawLine)
              // Suppress expected RIC output (poll timeout errors)
              if (!isExpectedRicOutput(rawLine)) {
                const { prefix, content } = formatLine(rawLine)
                process.stdout.write(`${prefix} ${content}\n`)
              }
            }),
          ),
          Effect.fork,
        )

        // Process stderr - filter expected errors, forward the rest
        const stderrFiber = yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((rawLine) =>
            Effect.sync(() => {
              stderr.push(rawLine)
              // Suppress expected RIC output (poll timeout errors)
              if (!isExpectedRicOutput(rawLine)) {
                const { prefix, content } = formatLine(rawLine)
                process.stderr.write(`${prefix} ${content}\n`)
              }
            }),
          ),
          Effect.fork,
        )

        // Wait for both streams and exit code
        yield* Effect.all([
          Effect.fromFiber(stdoutFiber),
          Effect.fromFiber(stderrFiber),
        ])

        const exitCode = yield* proc.exitCode

        // Only suppress warnings for expected exit codes:
        // - 0: Clean exit
        // - 1: Lambda RIC exit after 503 poll timeout (expected)
        // - 143 (128+15): SIGTERM from docker stop
        // - 137 (128+9): SIGKILL from docker stop timeout
        const expectedExitCodes = [0, 1, 143, 137]
        if (!expectedExitCodes.includes(exitCode)) {
          yield* Effect.logWarning(`Container exited with code ${exitCode}`)
        } else if (exitCode !== 0) {
          yield* Effect.logDebug(`Container exited with code ${exitCode}`)
        }

        return {
          exitCode,
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
        }
      })

    const runScoped: DockerService["runScoped"] = (config) =>
      Effect.gen(function* () {
        const args = buildDockerRunArgs(config, runtime)

        yield* Effect.logInfo(`Running (scoped): docker ${args.join(" ")}`)

        const command = PlatformCommand.make(runtime.dockerPath, ...args)

        const proc = yield* PlatformCommand.start(command)

        // Fork output processing in background (will be interrupted when scope closes)
        yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              process.stdout.write(`[Container] ${line}\n`)
            }),
          ),
          Effect.fork,
        )

        yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              process.stderr.write(`[Container] ${line}\n`)
            }),
          ),
          Effect.fork,
        )

        return proc
      })

    const build: DockerService["build"] = (options) =>
      Effect.gen(function* () {
        const args = [
          "build",
          "-t",
          options.imageName,
          "--platform",
          options.platform ?? "linux/arm64",
          options.contextPath,
        ]

        yield* Effect.logInfo(`Building image: ${options.imageName}`)
        yield* Effect.logDebug(`Context: ${options.contextPath}`)

        const command = PlatformCommand.make(runtime.dockerPath, ...args)

        const proc = yield* PlatformCommand.start(command)

        // Process stdout (debug only)
        const stdoutFiber = yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.logDebug(`[Docker] ${line}`)),
          Effect.fork,
        )

        // Process stderr (debug only)
        const stderrFiber = yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.logDebug(`[Docker] ${line}`)),
          Effect.fork,
        )

        // Wait for streams and exit code
        yield* Effect.all([
          Effect.fromFiber(stdoutFiber),
          Effect.fromFiber(stderrFiber),
        ])

        const exitCode = yield* proc.exitCode

        if (exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`Docker build failed with code ${exitCode}`),
          )
        }

        yield* Effect.logInfo(`Built image: ${options.imageName}`)
      })

    const pull: DockerService["pull"] = (imageUri) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Pulling image: ${imageUri}`)

        const command = PlatformCommand.make(
          runtime.dockerPath,
          "pull",
          imageUri,
        )

        const proc = yield* PlatformCommand.start(command)

        // Process stdout (debug only)
        const stdoutFiber = yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.logDebug(`[Docker] ${line}`)),
          Effect.fork,
        )

        // Process stderr (debug only)
        const stderrFiber = yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.logDebug(`[Docker] ${line}`)),
          Effect.fork,
        )

        // Wait for streams and exit code
        yield* Effect.all([
          Effect.fromFiber(stdoutFiber),
          Effect.fromFiber(stderrFiber),
        ])

        const exitCode = yield* proc.exitCode

        if (exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`Docker pull failed with code ${exitCode}`),
          )
        }

        yield* Effect.logInfo(`Pulled image: ${imageUri}`)
      })

    const list: DockerService["list"] = (containerNameFilter) =>
      Effect.gen(function* () {
        const command = PlatformCommand.make(
          runtime.dockerPath,
          "ps",
          "-q",
          "--filter",
          `name=${containerNameFilter}`,
        )

        const proc = yield* PlatformCommand.start(command)

        // Collect stdout
        const containerIds: string[] = []
        yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              const trimmed = line.trim()
              if (trimmed) {
                containerIds.push(trimmed)
              }
            }),
          ),
        )

        const exitCode = yield* proc.exitCode

        if (exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`Docker ps failed with code ${exitCode}`),
          )
        }

        return containerIds
      })

    const stop: DockerService["stop"] = (containerNameFilter) =>
      Effect.gen(function* () {
        // First list matching containers
        const containerIds = yield* list(containerNameFilter)

        if (containerIds.length === 0) {
          yield* Effect.logDebug(
            `No containers found matching: ${containerNameFilter}`,
          )
          return 0
        }

        yield* Effect.logInfo(`Stopping containers: ${containerIds.join(", ")}`)

        // Stop all matching containers
        const command = PlatformCommand.make(
          runtime.dockerPath,
          "stop",
          ...containerIds,
        )

        const proc = yield* PlatformCommand.start(command)

        // Process output for logging
        yield* proc.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.logDebug(`[Docker stop] ${line.trim()}`),
          ),
        )

        const exitCode = yield* proc.exitCode

        if (exitCode !== 0) {
          yield* Effect.logWarning(
            `Docker stop exited with code ${exitCode} (some containers may have already stopped)`,
          )
        }

        return containerIds.length
      })

    return {
      run,
      runScoped,
      build,
      pull,
      stop,
      list,
      getRuntimeInfo,
    } satisfies DockerService
  },
)

/**
 * Live Docker service layer.
 * Note: Does not require CommandExecutor in the layer - it's required
 * when the service methods are called.
 */
export const DockerLive: Layer.Layer<Docker, Error> = Layer.effect(
  Docker,
  makeDockerService,
)

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
  invocationContexts?: Map<string, { num: number }>
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
  invocationContexts: options.invocationContexts,
})

/**
 * Stream output from a Docker container.
 */
export interface ContainerOutput {
  type: "stdout" | "stderr"
  data: string
}
