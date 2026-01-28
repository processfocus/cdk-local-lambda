/**
 * Local command for running Lambda functions locally using Docker.
 *
 * This command:
 * 1. Starts CDK watch with CDK_LIVE=true and hotswap
 * 2. Discovers Lambda functions with live-lambda:handler tag
 * 3. Connects to AppSync Events
 * 4. Subscribes to invocation channels
 * 5. For each function, maintains ONE Docker container that handles all invocations
 * 6. Sends responses back via AppSync
 * 7. Re-discovers functions after each CDK deploy
 */

import { type ChildProcess, spawn } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  LambdaClient,
  ListFunctionsCommand,
  ListTagsCommand,
} from "@aws-sdk/client-lambda"
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Command, Options } from "@effect/cli"
import {
  type CommandExecutor,
  Command as PlatformCommand,
} from "@effect/platform"
import type { Process as EffectProcess } from "@effect/platform/CommandExecutor"
import { BunContext } from "@effect/platform-bun"
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  LogLevel,
  Queue,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect"
import {
  BOOTSTRAP_STACK_NAME,
  BOOTSTRAP_VERSION,
  buildChannelName,
  type InvocationMessage,
  LIVE_LAMBDA_DOCKER_TAG,
  LIVE_LAMBDA_TAG,
  type ResponseMessage,
  SSM_BASE_PATH,
} from "../../shared/types.js"
import { makeAppSyncClient } from "../appsync/client.js"
import {
  Docker,
  DockerLive,
  makeLambdaContainerConfig,
} from "../docker/container.js"
import {
  type WatchedDockerFunction,
  watchDockerContexts,
} from "../docker/watcher.js"
import {
  queueInvocation,
  type RuntimeApiState,
  startRuntimeApiServer,
  waitForResponse,
} from "../runtime-api/server.js"
import type {
  LambdaError,
  LambdaInitError,
  LambdaInvocation,
  LambdaResponse,
} from "../runtime-api/types.js"

/**
 * Discovered Lambda function info.
 */
interface DiscoveredFunction {
  functionName: string
  functionArn: string
  localHandler: string
  /** Local Docker context path for DockerImageFunction */
  dockerContextPath?: string
  memoryMB: number
  architecture?: "arm64" | "x86_64"
}

/**
 * Default idle timeout before proactively stopping containers.
 * Set slightly below the poll timeout (240s) to stop container before
 * the Lambda RIC gets a 503 error.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 230_000 // 230 seconds (~4 minutes)

/**
 * State for a running function container.
 */
interface FunctionContainer {
  fn: DiscoveredFunction
  runtimeState: RuntimeApiState
  /** The port the Runtime API server is listening on */
  port: number
  containerFiber: Fiber.RuntimeFiber<void, Error>
  containerName: string
  /** Docker image name for rebuilds */
  imageName: string
  /** Whether the container is currently being rebuilt (invocations will queue) */
  isRebuilding: boolean
  /** Map of requestId -> response resolver */
  pendingResponses: Map<
    string,
    {
      resolve: (response: ResponseMessage) => void
    }
  >
  /** Fiber for the idle shutdown timer, cancelled when new responses arrive */
  idleTimerFiber: Fiber.RuntimeFiber<void, never> | null
  /** Environment variables captured from first invocation */
  env: Record<string, string>
}

/**
 * State for a running Node.js worker process.
 */
interface NodejsWorker {
  fn: DiscoveredFunction
  runtimeState: RuntimeApiState
  /** The port the Runtime API server is listening on */
  port: number
  /** The spawned Bun process */
  workerProcess: ChildProcess
  /** Environment variables captured from first invocation */
  env: Record<string, string>
}

/**
 * Invocation context for tracking and logging.
 */
export interface InvocationContext {
  /** Sequential invocation number */
  num: number
  /** Start timestamp in milliseconds */
  start: number
  /** Function name */
  fn: string
  /** Whether this is a Docker container invocation */
  isDocker: boolean
}

/**
 * Check if bootstrap stack version matches the expected version.
 * Returns true if version matches, false if missing or mismatched.
 */
const checkBootstrapVersion = (qualifier: string) =>
  Effect.gen(function* () {
    const ssmClient = new SSMClient({})
    const basePath = `${SSM_BASE_PATH}/${qualifier}`

    const result = yield* Effect.tryPromise({
      try: async () => {
        const response = await ssmClient.send(
          new GetParameterCommand({ Name: `${basePath}/version` }),
        )
        return response.Parameter?.Value
      },
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    if (result === null) {
      yield* Effect.logInfo("Bootstrap stack version parameter not found")
      return false
    }

    if (result !== BOOTSTRAP_VERSION) {
      yield* Effect.logInfo(
        `Bootstrap stack version mismatch: found ${result}, expected ${BOOTSTRAP_VERSION}`,
      )
      return false
    }

    return true
  })

/**
 * Run the bootstrap stack deployment.
 */
const runBootstrap = (options: { profile?: string; region?: string }) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Running bootstrap stack deployment...")

    // Resolve the CDK app path relative to this module
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const cdkAppPath = path.resolve(__dirname, "..", "cdk-app.js")

    const args = [
      "cdk",
      "deploy",
      BOOTSTRAP_STACK_NAME,
      "--require-approval",
      "never",
      "--app",
      `bun ${cdkAppPath}`,
    ]

    if (options.profile) {
      args.push("--profile", options.profile)
    }

    const env: Record<string, string> = {
      ...process.env,
    } as Record<string, string>
    if (options.region) {
      env.AWS_REGION = options.region
      env.CDK_DEFAULT_REGION = options.region
    }

    yield* Effect.logInfo(`Running: npx ${args.join(" ")}`)

    const command = PlatformCommand.make("npx", ...args).pipe(
      PlatformCommand.env(env),
      PlatformCommand.stdin("inherit"),
    )

    const proc = yield* PlatformCommand.start(command)

    // Stream output to console
    yield* Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          process.stdout.write(`${line}\n`)
        }),
      ),
    )

    const exitCode = yield* proc.exitCode
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`Bootstrap deployment failed with exit code ${exitCode}`),
      )
    }

    yield* Effect.logInfo("Bootstrap stack deployed successfully!")
  }).pipe(Effect.scoped)

/**
 * Ensure bootstrap stack is deployed with correct version.
 * Automatically deploys if missing or outdated.
 */
const ensureBootstrap = (options: {
  qualifier: string
  profile?: string
  region?: string
}) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("[Local] Checking bootstrap stack version...")

    const versionOk = yield* checkBootstrapVersion(options.qualifier)

    if (!versionOk) {
      yield* Effect.logInfo(
        "[Local] Bootstrap stack needs to be deployed or updated.",
      )
      yield* runBootstrap({ profile: options.profile, region: options.region })
    } else {
      yield* Effect.logDebug("[Local] Bootstrap stack version OK.")
    }
  })

/**
 * Read AppSync endpoints from SSM.
 */
const getAppSyncEndpoints = (qualifier: string) =>
  Effect.gen(function* () {
    const ssmClient = new SSMClient({})
    const basePath = `${SSM_BASE_PATH}/${qualifier}`

    const getParam = (name: string) =>
      Effect.tryPromise({
        try: async () => {
          const result = await ssmClient.send(
            new GetParameterCommand({ Name: `${basePath}/${name}` }),
          )
          return result.Parameter?.Value ?? ""
        },
        catch: (error) =>
          new Error(`Failed to get SSM parameter ${name}: ${String(error)}`),
      })

    const httpEndpoint = yield* getParam("http-endpoint")
    const realtimeEndpoint = yield* getParam("realtime-endpoint")

    return { httpEndpoint, realtimeEndpoint }
  })

/**
 * CloudFormation stack name tag (set automatically by CDK)
 */
const CFN_STACK_NAME_TAG = "aws:cloudformation:stack-name"

/**
 * Discover Lambda functions with live-lambda tags.
 * @param stackFilter - Optional list of stack names to filter by
 */
const discoverFunctions = (stackFilter?: string[]) =>
  Effect.gen(function* () {
    const lambdaClient = new LambdaClient({})
    const functions: DiscoveredFunction[] = []

    // List all functions
    let nextMarker: string | undefined
    do {
      const listResponse = yield* Effect.tryPromise({
        try: () =>
          lambdaClient.send(new ListFunctionsCommand({ Marker: nextMarker })),
        catch: (error) =>
          new Error(`Failed to list functions: ${String(error)}`),
      })

      for (const fn of listResponse.Functions ?? []) {
        // Get tags for each function
        const tagsResult = yield* Effect.tryPromise({
          try: () =>
            lambdaClient.send(
              new ListTagsCommand({ Resource: fn.FunctionArn }),
            ),
          catch: () => new Error(`Failed to get tags for ${fn.FunctionName}`),
        }).pipe(
          Effect.catchAll(() =>
            Effect.succeed({ Tags: {} as Record<string, string> }),
          ),
        )

        const tags = tagsResult.Tags ?? {}

        // Check for live-lambda tag (handler) or docker-context tag
        if (tags[LIVE_LAMBDA_TAG] || tags[LIVE_LAMBDA_DOCKER_TAG]) {
          // Filter by stack name if specified
          if (stackFilter && stackFilter.length > 0) {
            const stackName = tags[CFN_STACK_NAME_TAG]
            if (!stackName || !stackFilter.includes(stackName)) {
              continue
            }
          }

          // Determine architecture from Lambda config
          const architectures = fn.Architectures ?? ["x86_64"]
          const architecture = architectures.includes("arm64")
            ? ("arm64" as const)
            : ("x86_64" as const)

          const discovered: DiscoveredFunction = {
            functionName: fn.FunctionName!,
            functionArn: fn.FunctionArn!,
            localHandler: tags[LIVE_LAMBDA_TAG] ?? "",
            dockerContextPath: tags[LIVE_LAMBDA_DOCKER_TAG],
            memoryMB: fn.MemorySize ?? 128,
            architecture,
          }
          functions.push(discovered)
        }
      }

      nextMarker = listResponse.NextMarker
    } while (nextMarker)

    return functions
  })

/**
 * Start a long-running Docker container for a function.
 * Builds the image from the local Docker context path, then runs it.
 * The container continuously polls our Runtime API for invocations.
 * Uses Effect.forkDaemon to ensure the container runs independently with context.
 */
const startFunctionContainer = (
  fn: DiscoveredFunction,
  port: number,
  projectRoot: string,
  additionalEnv: Record<string, string>,
  invocationContexts?: Map<string, { num: number }>,
): Effect.Effect<
  Fiber.RuntimeFiber<void, Error>,
  Error,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (!fn.dockerContextPath) {
      return yield* Effect.fail(
        new Error(`Function ${fn.functionName} has no Docker context path`),
      )
    }

    const docker = yield* Docker

    const dockerRuntime = yield* docker.getRuntimeInfo()
    const runtimeApiHost = dockerRuntime.isDockerDesktop
      ? "host.docker.internal"
      : "runtime.api"

    // Generate a local image name from function name
    const imageName = `live-lambda-${fn.functionName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`

    // Resolve the context path relative to project root
    const contextPath = fn.dockerContextPath.startsWith("/")
      ? fn.dockerContextPath
      : `${projectRoot}/${fn.dockerContextPath}`

    // Determine platform from architecture
    const platform = fn.architecture === "arm64" ? "linux/arm64" : "linux/amd64"

    // Build the Docker image from local context
    yield* docker
      .build({
        contextPath,
        imageName,
        platform,
      })
      .pipe(Effect.scoped)

    const containerConfig = makeLambdaContainerConfig({
      imageUri: imageName,
      runtimeApiHost,
      runtimeApiPort: port,
      functionName: fn.functionName,
      functionVersion: "$LATEST",
      memoryMB: fn.memoryMB,
      timeoutSeconds: 3600, // Long timeout - container stays running
      platform,
      additionalEnv,
      invocationContexts,
    })

    yield* Effect.logInfo(
      `Starting container for ${fn.functionName} on port ${port}`,
    )

    // Use Effect.forkDaemon to run the container independently with context preserved
    // Effect.scoped provides the scope needed by docker.run
    const fiber = yield* docker.run(containerConfig).pipe(
      Effect.scoped,
      Effect.map(() => undefined as void),
      Effect.forkDaemon,
    )

    return fiber
  }).pipe(Effect.provide(DockerLive))

// Type guards for response types
const isLambdaResponse = (
  r: LambdaResponse | LambdaError | LambdaInitError,
): r is LambdaResponse => "body" in r && !("errorType" in r)

const isLambdaError = (
  r: LambdaResponse | LambdaError | LambdaInitError,
): r is LambdaError => "requestId" in r && "errorType" in r

const isLambdaInitError = (
  r: LambdaResponse | LambdaError | LambdaInitError,
): r is LambdaInitError => !("requestId" in r) && "errorType" in r

/**
 * Reset the idle timer for a container.
 * After the timeout expires with no new responses, the container is stopped.
 * This prevents the confusing 503 error from the Lambda RIC when the poll times out.
 */
const resetIdleTimer = (
  container: FunctionContainer,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  idleTimeoutMs: number,
): Effect.Effect<void, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Cancel existing timer if any
    if (container.idleTimerFiber) {
      yield* Fiber.interrupt(container.idleTimerFiber).pipe(
        Effect.catchAll(() => Effect.void),
      )
      container.idleTimerFiber = null
    }

    // Start new timer - use never for error type since we catch all errors
    const timerFiber: Fiber.RuntimeFiber<void, never> = yield* Effect.gen(
      function* () {
        yield* Effect.sleep(Duration.millis(idleTimeoutMs))

        // Timer expired - stop container proactively
        yield* Effect.logInfo(
          `[Local] Stopping idle container ${container.fn.functionName} (will restart on next invocation)`,
        )

        // Stop the container using Docker
        const docker = yield* Docker
        yield* docker.stop(container.containerName).pipe(
          Effect.scoped,
          Effect.catchAll(() => Effect.void),
        )

        // Remove from map so next invocation creates fresh container
        const currentContainers = yield* Ref.get(containersRef)
        currentContainers.delete(container.fn.functionName)
        yield* Ref.set(containersRef, currentContainers)
      },
    ).pipe(
      Effect.provide(DockerLive),
      Effect.catchAll(() => Effect.void),
      Effect.forkDaemon,
    )

    container.idleTimerFiber = timerFiber
  })

/**
 * Process responses from a container and dispatch to waiting callers.
 * After each response, resets the idle timer to proactively stop the container
 * before the poll timeout causes confusing Lambda RIC errors.
 */
const processContainerResponses = (
  container: FunctionContainer,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  idleTimeoutMs: number,
  client: ReturnType<typeof makeAppSyncClient>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const responseChannel = buildChannelName.response(container.fn.functionName)

    // Continuously process responses from the container
    while (true) {
      const result = yield* waitForResponse(container.runtimeState)

      let response: ResponseMessage
      if (isLambdaResponse(result)) {
        response = {
          type: "response",
          requestId: result.requestId,
          result: result.body,
        }
      } else if (isLambdaError(result)) {
        response = {
          type: "response",
          requestId: result.requestId,
          error: {
            errorType: result.errorType,
            errorMessage: result.errorMessage,
            stackTrace: result.stackTrace,
          },
        }
      } else if (isLambdaInitError(result)) {
        yield* Effect.logError(
          `[Local] Init error: ${result.errorType}: ${result.errorMessage}`,
        )
        continue
      } else {
        continue
      }

      // Send response back via AppSync
      yield* client.publishResponse(responseChannel, response)
      yield* Effect.logDebug(`[Local] Sent response for ${response.requestId}`)

      // Print end marker with timing
      const ctx = invocationContexts.get(response.requestId)
      if (ctx) {
        const durationMs = Date.now() - ctx.start
        if (response.error) {
          console.log(
            `[${ctx.num}] \u2514\u2500\u2500 \u2717 ${response.error.errorType}: ${response.error.errorMessage} (${durationMs}ms) \u2500\u2500`,
          )
        } else {
          console.log(
            `[${ctx.num}] \u2514\u2500\u2500 \u2713 Done (${durationMs}ms) \u2500\u2500`,
          )
        }
        invocationContexts.delete(response.requestId)
      }

      // Reset idle timer - container will be stopped if no new invocations arrive
      yield* resetIdleTimer(container, containersRef, idleTimeoutMs)
    }
  })

/**
 * Start a Node.js worker process for a function.
 * Spawns Bun to run the runtime wrapper with the handler path.
 * The worker continuously polls our Runtime API for invocations.
 */
const startNodejsWorker = (
  fn: DiscoveredFunction,
  port: number,
  projectRoot: string,
  env: Record<string, string>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<ChildProcess, Error> =>
  Effect.gen(function* () {
    if (!fn.localHandler) {
      return yield* Effect.fail(
        new Error(`Function ${fn.functionName} has no local handler path`),
      )
    }

    // Resolve the runtime wrapper path relative to this module
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const runtimeWrapperPath = path.resolve(
      __dirname,
      "..",
      "runtime-wrapper",
      "nodejs-runtime.js",
    )

    // Get absolute path to bun for pure env isolation (no PATH dependency)
    const bunPath = Bun.which("bun")
    if (!bunPath) {
      return yield* Effect.fail(
        new Error("Could not find 'bun' executable in PATH"),
      )
    }

    // Build environment for the worker process
    // Pure isolation: only env from bridge + local overrides, no local PATH/HOME
    const workerEnv: NodeJS.ProcessEnv = {
      // Start with env vars from the bridge Lambda (AWS credentials, user-defined vars)
      ...env,
      // Local overrides (these are set by the daemon, not from bridge)
      AWS_LAMBDA_RUNTIME_API: `localhost:${port}`,
      _HANDLER: fn.localHandler,
      LAMBDA_TASK_ROOT: projectRoot,
      // Memory limit for context object
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(fn.memoryMB),
    }

    yield* Effect.logDebug(
      `[Local] Starting Node.js worker for ${fn.functionName} on port ${port}`,
    )
    yield* Effect.logDebug(`[Local] Handler: ${fn.localHandler}`)

    // Spawn Bun with --watch to automatically restart when handler files change
    // This enables hot-reload without needing to restart the daemon
    // Use absolute bun path for pure env isolation (no PATH dependency)
    const workerProcess = spawn(bunPath, ["--watch", runtimeWrapperPath], {
      cwd: projectRoot,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

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
      if (match) {
        const requestId = match[2]
        const ctx = invocationContexts.get(requestId)
        if (ctx) {
          // Strip timestamp and request ID, keep just LEVEL MESSAGE
          return { prefix: `[${ctx.num}]`, content: match[3] }
        }
      }
      return { prefix: "[Worker]", content: line }
    }

    // Forward stdout/stderr with invocation number prefix
    workerProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n")
      for (const rawLine of lines) {
        const { prefix, content } = formatLine(rawLine)
        console.log(`${prefix} ${content}`)
      }
    })

    workerProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n")
      for (const rawLine of lines) {
        const { prefix, content } = formatLine(rawLine)
        console.error(`${prefix} ${content}`)
      }
    })

    workerProcess.on("error", (err) => {
      Effect.runSync(
        Effect.logError(`Worker error: ${err.message}`).pipe(
          Effect.annotateLogs("function", fn.functionName),
        ),
      )
    })

    workerProcess.on("close", (code) => {
      Effect.runSync(
        Effect.logInfo(`Worker exited with code ${code}`).pipe(
          Effect.annotateLogs("function", fn.functionName),
        ),
      )
    })

    return workerProcess
  })

/**
 * Process responses from a Node.js worker and dispatch to waiting callers.
 */
const processWorkerResponses = (
  worker: NodejsWorker,
  client: ReturnType<typeof makeAppSyncClient>,
  invocationContexts: Map<string, InvocationContext>,
) =>
  Effect.gen(function* () {
    const responseChannel = buildChannelName.response(worker.fn.functionName)

    // Continuously process responses from the worker
    while (true) {
      const result = yield* waitForResponse(worker.runtimeState)

      let response: ResponseMessage
      if (isLambdaResponse(result)) {
        response = {
          type: "response",
          requestId: result.requestId,
          result: result.body,
        }
      } else if (isLambdaError(result)) {
        response = {
          type: "response",
          requestId: result.requestId,
          error: {
            errorType: result.errorType,
            errorMessage: result.errorMessage,
            stackTrace: result.stackTrace,
          },
        }
      } else if (isLambdaInitError(result)) {
        yield* Effect.logError(
          `[Local] Worker init error: ${result.errorType}: ${result.errorMessage}`,
        )
        continue
      } else {
        continue
      }

      // Send response back via AppSync
      yield* client.publishResponse(responseChannel, response)
      yield* Effect.logDebug(`[Local] Sent response for ${response.requestId}`)

      // Print end marker with timing
      const ctx = invocationContexts.get(response.requestId)
      if (ctx) {
        const durationMs = Date.now() - ctx.start
        if (response.error) {
          console.log(
            `[${ctx.num}] \u2514\u2500\u2500 \u2717 ${response.error.errorType}: ${response.error.errorMessage} (${durationMs}ms) \u2500\u2500`,
          )
        } else {
          console.log(
            `[${ctx.num}] \u2514\u2500\u2500 \u2713 Done (${durationMs}ms) \u2500\u2500`,
          )
        }
        invocationContexts.delete(response.requestId)
      }
    }
  })

/**
 * Ensure a Node.js worker is started for a function.
 * If the worker already exists, return it.
 * Otherwise, create the Runtime API server, add to workers map, and start the worker.
 */
const ensureWorkerStarted = (
  fn: DiscoveredFunction,
  invocationEnv: Record<string, string>,
  workersRef: Ref.Ref<Map<string, NodejsWorker>>,
  serverScope: Scope.Scope,
  projectRoot: string,
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<NodejsWorker, Error> =>
  Effect.gen(function* () {
    // Check if worker already exists
    const currentWorkers = yield* Ref.get(workersRef)
    const existing = currentWorkers.get(fn.functionName)
    if (existing) {
      // Check if env vars have changed (e.g., after CDK redeploy)
      const envChanged =
        JSON.stringify(existing.env) !== JSON.stringify(invocationEnv)
      if (envChanged) {
        yield* Effect.logInfo(
          `[Local] Environment changed for ${fn.functionName}, restarting worker...`,
        )
        // Kill the old worker
        yield* Effect.try(() => existing.workerProcess.kill("SIGTERM")).pipe(
          Effect.catchAll(() => Effect.void),
        )
        // Remove from map so we create a new one below
        currentWorkers.delete(fn.functionName)
        yield* Ref.set(workersRef, currentWorkers)
      } else {
        return existing
      }
    }

    // Worker doesn't exist - start it lazily
    yield* Effect.logDebug(
      `[Local] Starting Node.js worker for first invocation of ${fn.functionName}...`,
    )

    // Create Runtime API server on ephemeral port
    const { port, state: runtimeState } = yield* startRuntimeApiServer().pipe(
      Effect.provideService(Scope.Scope, serverScope),
    )

    // Create worker object (without process initially - will be set after start)
    // We add to map BEFORE starting worker to handle concurrent invocations
    const worker: NodejsWorker = {
      fn,
      runtimeState,
      port,
      workerProcess: undefined as unknown as ChildProcess, // Will be set shortly
      env: invocationEnv,
    }

    // Add to map immediately to prevent race conditions
    currentWorkers.set(fn.functionName, worker)
    yield* Ref.set(workersRef, currentWorkers)

    // Start the worker process - remove from map on failure
    const workerProcess = yield* startNodejsWorker(
      fn,
      port,
      projectRoot,
      invocationEnv,
      invocationContexts,
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Remove broken worker from map on failure
          yield* Effect.logError(
            `[Local] Failed to start worker for ${fn.functionName}: ${error}`,
          )
          const current = yield* Ref.get(workersRef)
          current.delete(fn.functionName)
          yield* Ref.set(workersRef, current)
          return yield* Effect.fail(error)
        }),
      ),
    )

    // Update worker with the process
    worker.workerProcess = workerProcess

    // Start processing responses in the background
    Effect.runFork(
      processWorkerResponses(worker, appSyncClient, invocationContexts),
    )

    return worker
  })

/**
 * Ensure a container is started for a function.
 * If the container already exists, return it.
 * If the env vars have changed, restart the container.
 * Otherwise, create the Runtime API server, add to containers map, and start the container.
 */
const ensureContainerStarted = (
  fn: DiscoveredFunction,
  invocationEnv: Record<string, string>,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  serverScope: Scope.Scope,
  projectRoot: string,
  idleTimeoutMs: number,
  pollTimeoutMs: number,
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<FunctionContainer, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Check if container already exists
    const currentContainers = yield* Ref.get(containersRef)
    const existing = currentContainers.get(fn.functionName)
    if (existing) {
      // Check if env vars have changed (e.g., after CDK redeploy)
      const envChanged =
        JSON.stringify(existing.env) !== JSON.stringify(invocationEnv)
      if (envChanged) {
        yield* Effect.logInfo(
          `[Local] Environment changed for ${fn.functionName}, restarting container...`,
        )
        // Stop the existing container
        yield* Fiber.interrupt(existing.containerFiber).pipe(
          Effect.catchAll(() => Effect.void),
        )
        // Remove from map so we create a new one below
        currentContainers.delete(fn.functionName)
        yield* Ref.set(containersRef, currentContainers)
      } else {
        return existing
      }
    }

    // Container doesn't exist - start it lazily
    yield* Effect.logInfo(
      `[Local] Starting container for first invocation of ${fn.functionName}...`,
    )

    // Create Runtime API server on ephemeral port
    // Use poll timeout that's shorter than idle timeout so container exits naturally
    const { port, state: runtimeState } = yield* startRuntimeApiServer(
      pollTimeoutMs,
    ).pipe(Effect.provideService(Scope.Scope, serverScope))

    // Generate container name and image name
    const containerName = `lambda-${fn.functionName.replace(/[^a-zA-Z0-9]/g, "-")}`
    const imageName = `live-lambda-${fn.functionName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`

    // Create container object (without fiber initially - will be set after start)
    // We add to map BEFORE starting container to handle concurrent invocations
    const container: FunctionContainer = {
      fn,
      runtimeState,
      port,
      containerFiber: undefined as unknown as Fiber.RuntimeFiber<void, Error>, // Will be set shortly
      containerName,
      imageName,
      isRebuilding: false,
      pendingResponses: new Map(),
      idleTimerFiber: null,
      env: invocationEnv,
    }

    // Add to map immediately to prevent race conditions
    currentContainers.set(fn.functionName, container)
    yield* Ref.set(containersRef, currentContainers)

    // Build and start the container - remove from map on failure
    const containerFiber = yield* startFunctionContainer(
      fn,
      port,
      projectRoot,
      invocationEnv,
      invocationContexts,
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Remove broken container from map on failure
          yield* Effect.logError(
            `[Local] Failed to start container for ${fn.functionName}: ${error}`,
          )
          const current = yield* Ref.get(containersRef)
          current.delete(fn.functionName)
          yield* Ref.set(containersRef, current)
          return yield* Effect.fail(error)
        }),
      ),
    )

    // Update container with the fiber
    container.containerFiber = containerFiber

    // Start processing responses in the background using forkDaemon
    yield* processContainerResponses(
      container,
      containersRef,
      idleTimeoutMs,
      appSyncClient,
      invocationContexts,
    ).pipe(Effect.forkDaemon)

    return container
  })

/**
 * Rebuild a Docker container after file changes.
 * Invocations arriving during rebuild will be queued and picked up by the new container.
 */
const rebuildDockerContainer = (
  functionId: string,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  projectRoot: string,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const containers = yield* Ref.get(containersRef)
    const container = containers.get(functionId)

    if (!container) {
      yield* Effect.logInfo(
        `[Local] Cannot rebuild ${functionId} - container not found`,
      )
      return
    }

    // Mark as rebuilding - invocations will still queue but we log it
    container.isRebuilding = true

    yield* Effect.logDebug(`[Local] Rebuilding container for ${functionId}...`)

    const docker = yield* Docker

    // Stop the existing container using Docker service
    const containerId = container.containerName
    yield* Effect.logInfo(
      `[Local] Stopping container with name prefix: ${containerId}`,
    )

    const stopCount = yield* docker.stop(containerId).pipe(
      Effect.scoped,
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Note: Container stop had issue: ${error}`)
          return 0
        }),
      ),
    )
    yield* Effect.logDebug(`[Local] Stopped ${stopCount} container(s)`)

    // Resolve the context path
    const fn = container.fn
    const contextPath = fn.dockerContextPath?.startsWith("/")
      ? fn.dockerContextPath
      : `${projectRoot}/${fn.dockerContextPath}`

    // Determine platform from architecture
    const platform = fn.architecture === "arm64" ? "linux/arm64" : "linux/amd64"

    // Rebuild the Docker image
    yield* docker
      .build({
        contextPath,
        imageName: container.imageName,
        platform,
      })
      .pipe(Effect.scoped)

    // Restart the container by triggering container startup
    // The existing fiber will have exited when we stopped the container
    // We need to start a new one
    const dockerRuntime = yield* docker.getRuntimeInfo()
    const runtimeApiHost = dockerRuntime.isDockerDesktop
      ? "host.docker.internal"
      : "runtime.api"

    yield* Effect.logInfo(
      `[Local] New container will connect to Runtime API at ${runtimeApiHost}:${container.port}`,
    )

    const containerConfig = makeLambdaContainerConfig({
      imageUri: container.imageName,
      runtimeApiHost,
      runtimeApiPort: container.port,
      functionName: fn.functionName,
      functionVersion: "$LATEST",
      memoryMB: fn.memoryMB,
      timeoutSeconds: 3600,
      platform,
    })

    // Start the new container
    yield* Effect.logDebug(
      `[Local] Starting new container for ${functionId}...`,
    )

    // Use Effect.forkDaemon to run the container independently
    const newFiber = yield* docker.run(containerConfig).pipe(
      Effect.scoped,
      Effect.tap((result) =>
        Effect.gen(function* () {
          // Only suppress errors for expected exit codes from docker stop:
          // 0: clean, 143: SIGTERM, 137: SIGKILL
          const code = result.exitCode
          if (code !== 0 && code !== 143 && code !== 137) {
            yield* Effect.logError(
              `Container for ${functionId} exited with code ${code}`,
            )
            yield* Effect.logError(`stderr: ${result.stderr}`)
          }
        }),
      ),
      Effect.map(() => undefined as void),
      Effect.catchAll((error) =>
        Effect.logError(`Container error for ${functionId}: ${error}`),
      ),
      Effect.forkDaemon,
    )

    // Update the container state with the new fiber
    container.containerFiber = newFiber

    // Wait a moment for the container to start and begin polling
    yield* Effect.sleep("2 seconds")

    container.isRebuilding = false
    yield* Effect.logDebug(`[Local] Container rebuilt for ${functionId}`)
  }).pipe(Effect.provide(DockerLive))

/**
 * Handle incoming invocations for a Docker container function by queueing them.
 * Starts the container lazily if not already running.
 * Invocations are queued even if a rebuild is in progress - the new container will pick them up.
 */
const handleDockerInvocation = (
  fn: DiscoveredFunction,
  invocation: InvocationMessage,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  serverScope: Scope.Scope,
  projectRoot: string,
  idleTimeoutMs: number,
  pollTimeoutMs: number,
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
  invocationCounter: Ref.Ref<number>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Ensure container is started (lazy startup on first invocation)
    // Use env from invocation (captured from bridge Lambda on first invoke)
    const container = yield* ensureContainerStarted(
      fn,
      invocation.env ?? {},
      containersRef,
      serverScope,
      projectRoot,
      idleTimeoutMs,
      pollTimeoutMs,
      appSyncClient,
      invocationContexts,
    )

    // Assign invocation number and track context for logging
    const invocationNum = yield* Ref.updateAndGet(
      invocationCounter,
      (n) => n + 1,
    )
    const startTime = Date.now()
    invocationContexts.set(invocation.requestId, {
      num: invocationNum,
      start: startTime,
      fn: fn.functionName,
      isDocker: true,
    })

    // Print start marker
    console.log(
      `\n[${invocationNum}] \u250c\u2500\u2500 [Docker] ${fn.functionName} \u2500\u2500`,
    )

    // Log if queuing during a rebuild
    if (container.isRebuilding) {
      yield* Effect.logDebug(
        `[Local] Queueing invocation ${invocation.requestId} for ${fn.functionName} (rebuild in progress, will be picked up by new container)`,
      )
    } else {
      yield* Effect.logDebug(
        `[Local] Queueing invocation ${invocation.requestId} for ${fn.functionName}`,
      )
    }

    const lambdaInvocation: LambdaInvocation = {
      requestId: invocation.requestId,
      event: invocation.event,
      invokedFunctionArn: invocation.context.invokedFunctionArn,
      deadlineMs: Date.now() + invocation.context.getRemainingTimeInMillis,
      functionName: fn.functionName,
      functionVersion: invocation.context.functionVersion,
      memoryLimitMB: fn.memoryMB,
      logGroupName: invocation.context.logGroupName,
      logStreamName: invocation.context.logStreamName,
    }

    yield* Effect.logDebug(
      `[Local] Queueing to Runtime API on port ${container.port}`,
    )
    yield* queueInvocation(container.runtimeState, lambdaInvocation)
    yield* Effect.logDebug(`[Local] Invocation queued successfully`)
  })

/**
 * Handle incoming invocations for a Node.js function by queueing them.
 * Starts the worker lazily if not already running.
 */
const handleNodejsInvocation = (
  fn: DiscoveredFunction,
  invocation: InvocationMessage,
  workersRef: Ref.Ref<Map<string, NodejsWorker>>,
  serverScope: Scope.Scope,
  projectRoot: string,
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
  invocationCounter: Ref.Ref<number>,
  invocationContexts: Map<string, InvocationContext>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // Get env vars from invocation (forwarded from bridge Lambda)
    const invocationEnv = invocation.env ?? {}

    // Ensure worker is started (lazy startup on first invocation)
    const worker = yield* ensureWorkerStarted(
      fn,
      invocationEnv,
      workersRef,
      serverScope,
      projectRoot,
      appSyncClient,
      invocationContexts,
    )

    // Assign invocation number and track context for logging
    const invocationNum = yield* Ref.updateAndGet(
      invocationCounter,
      (n) => n + 1,
    )
    const startTime = Date.now()
    invocationContexts.set(invocation.requestId, {
      num: invocationNum,
      start: startTime,
      fn: fn.functionName,
      isDocker: false,
    })

    // Print start marker
    console.log(
      `\n[${invocationNum}] \u250c\u2500\u2500 ${fn.functionName} \u2500\u2500`,
    )

    yield* Effect.logDebug(
      `[Local] Queueing invocation ${invocation.requestId} for ${fn.functionName}`,
    )

    const lambdaInvocation: LambdaInvocation = {
      requestId: invocation.requestId,
      event: invocation.event,
      invokedFunctionArn: invocation.context.invokedFunctionArn,
      deadlineMs: Date.now() + invocation.context.getRemainingTimeInMillis,
      functionName: fn.functionName,
      functionVersion: invocation.context.functionVersion,
      memoryLimitMB: fn.memoryMB,
      logGroupName: invocation.context.logGroupName,
      logStreamName: invocation.context.logStreamName,
    }

    yield* queueInvocation(worker.runtimeState, lambdaInvocation)
  })

/**
 * CDK watch event types.
 */
type CdkWatchEvent =
  | { readonly _tag: "StackDiscovered"; readonly stackName: string }
  | { readonly _tag: "DeployComplete" }

/**
 * Start CDK watch process with CDK_LIVE=true using Effect's Command.
 * Returns the process and a queue of events.
 */
const startCdkWatch = (
  options: {
    profile?: string
    region?: string
    stacks?: string[]
    all?: boolean
  },
  scope: Scope.Scope,
): Effect.Effect<
  { process: EffectProcess; events: Queue.Queue<CdkWatchEvent> },
  Error,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const args = [
      "cdk",
      "watch",
      "--hotswap-fallback",
      "--no-logs",
      "--method=direct",
    ]

    if (options.stacks && options.stacks.length > 0) {
      args.push(...options.stacks)
    } else if (options.all) {
      args.push("--all")
    }

    if (options.profile) {
      args.push("--profile", options.profile)
    }

    const env: Record<string, string> = {
      ...process.env,
      CDK_LIVE: "true",
    } as Record<string, string>

    if (options.region) {
      env.AWS_REGION = options.region
      env.CDK_DEFAULT_REGION = options.region
    }

    yield* Effect.logDebug(`Starting: npx ${args.join(" ")}`)

    const command = PlatformCommand.make("npx", ...args).pipe(
      PlatformCommand.env(env),
      PlatformCommand.runInShell(true),
      PlatformCommand.stdin("inherit"),
    )

    // Extend the process resource lifetime to the provided scope
    const proc = yield* PlatformCommand.start(command).pipe(Scope.extend(scope))

    // Event queue for callers to subscribe to
    const events = yield* Queue.unbounded<CdkWatchEvent>()

    // State tracking for deploy status messages
    let isDeploying = false
    let isFirstDeploy = true
    let outputBuffer = ""
    const discoveredStacks = new Set<string>()

    // Patterns to detect CDK watch behavior
    const deployCompletePattern = /✅\s+\S+|Deployment time:/
    const deployStartPattern = /Deploying|hotswap|Hotswapping|Bundling/i
    const noChangesPattern = /no changes|identical|up to date/i
    const errorPattern = /error|failed|Error|Failed|ERR!/i
    const stackNamePattern = /^(\S+):\s*deploying|✅\s+(\S+)/

    // Merge stdout and stderr, decode to text, split into lines
    const outputStream = Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.splitLines,
    )

    // Fork stream processing in background
    yield* outputStream.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          outputBuffer += line + "\n"

          // Log all output at debug level
          yield* Effect.logDebug(`[CDK] ${line}`)

          // Try to extract stack name
          const match = stackNamePattern.exec(line.trim())
          if (match) {
            const stackName = match[1] || match[2]
            if (stackName && !discoveredStacks.has(stackName)) {
              discoveredStacks.add(stackName)
              yield* Queue.offer(events, {
                _tag: "StackDiscovered",
                stackName,
              })
            }
          }

          // Detect deploy start
          if (!isDeploying && deployStartPattern.test(line)) {
            isDeploying = true
            if (!isFirstDeploy) {
              yield* Effect.logInfo("[CDK] Deploying...")
            }
          }

          // Detect errors - output immediately
          if (errorPattern.test(line)) {
            yield* Effect.sync(() => process.stderr.write(line + "\n"))
          }

          // Check for deploy completion (only trigger once per deploy cycle)
          if (isDeploying && deployCompletePattern.test(line)) {
            isDeploying = false
            isFirstDeploy = false
            outputBuffer = ""
            yield* Effect.logInfo("[CDK] Deploy complete")
            // Small delay to ensure AWS has propagated the changes
            yield* Effect.sleep("1 second")
            yield* Queue.offer(events, { _tag: "DeployComplete" })
          }

          // Check for no changes
          if (noChangesPattern.test(line)) {
            isDeploying = false
            outputBuffer = ""
          }
        }),
      ),
      // Log errors and exit code when stream ends
      Effect.tapError((error) =>
        Effect.logError(`[CDK] CDK watch error: ${error}`),
      ),
      Effect.ensuring(
        proc.exitCode.pipe(
          Effect.flatMap((code) =>
            code !== 0
              ? Effect.logError(`[CDK] CDK watch exited with code ${code}`)
              : Effect.logDebug(`[CDK] CDK watch exited with code ${code}`),
          ),
          Effect.catchAll(() => Effect.void),
        ),
      ),
      Effect.fork,
    )

    return { process: proc, events }
  })

/**
 * Common CLI options.
 */
const profileOption = Options.text("profile").pipe(
  Options.optional,
  Options.withDescription("AWS profile to use"),
)

const regionOption = Options.text("region").pipe(
  Options.optional,
  Options.withDescription("AWS region"),
)

const qualifierOption = Options.text("qualifier").pipe(
  Options.withDefault("hnb659fds"),
  Options.withDescription("CDK bootstrap qualifier"),
)

const stacksOption = Options.text("stacks").pipe(
  Options.optional,
  Options.withDescription(
    "Stack names to deploy (comma-separated, default: all)",
  ),
)

const allStacksOption = Options.boolean("all").pipe(
  Options.withDefault(false),
  Options.withDescription("Deploy all stacks (like cdk deploy --all)"),
)

const debugOption = Options.boolean("debug").pipe(
  Options.withDefault(false),
  Options.withDescription("Enable debug logging"),
)

const idleTimeoutOption = Options.integer("idle-timeout").pipe(
  Options.withDefault(DEFAULT_IDLE_TIMEOUT_MS),
  Options.withDescription(
    "Idle timeout in ms before stopping containers (default: 230000)",
  ),
)

const pollTimeoutOption = Options.integer("poll-timeout").pipe(
  Options.optional,
  Options.withDescription(
    "Poll timeout in ms for Runtime API (default: idle-timeout - 10s). Must be shorter than idle-timeout.",
  ),
)

/**
 * Local command definition.
 */
export const localCommand = Command.make(
  "local",
  {
    profile: profileOption,
    region: regionOption,
    qualifier: qualifierOption,
    stacks: stacksOption,
    all: allStacksOption,
    debug: debugOption,
    idleTimeout: idleTimeoutOption,
    pollTimeout: pollTimeoutOption,
  },
  ({
    profile,
    region,
    qualifier,
    stacks,
    all,
    debug,
    idleTimeout,
    pollTimeout,
  }) => {
    const logLevel = debug ? LogLevel.Debug : LogLevel.Info
    return Effect.gen(function* () {
      yield* Effect.logInfo("[Local] Starting local Lambda development...")

      const profileValue = profile._tag === "Some" ? profile.value : undefined
      const regionValue = region._tag === "Some" ? region.value : undefined
      const stacksFromOption =
        stacks._tag === "Some"
          ? stacks.value.split(",").map((s) => s.trim())
          : undefined

      // Poll timeout should be shorter than idle timeout so containers exit naturally
      // before we try to stop them. Default: idle timeout - 10 seconds.
      const effectivePollTimeout =
        pollTimeout._tag === "Some"
          ? pollTimeout.value
          : Math.max(idleTimeout - 10_000, 5_000) // At least 5 seconds

      if (profileValue) {
        process.env.AWS_PROFILE = profileValue
      }
      if (regionValue) {
        process.env.AWS_REGION = regionValue
      }

      // Bootstrap check must complete first
      yield* ensureBootstrap({
        qualifier,
        profile: profileValue,
        region: regionValue,
      })

      // Stack filter - populated from CDK watch output, used to filter Lambda discovery
      // Using object so closure in startOrUpdateDaemon sees updates
      const filterState = { stacks: stacksFromOption ?? ([] as string[]) }

      // Create a long-lived scope for all Runtime API servers and CDK watch process
      // Resources will run until this scope is closed (when the program ends)
      const serverScope = yield* Scope.make()

      // Start CDK watch immediately after bootstrap
      // Stack names are discovered from CDK watch output (no need for separate cdk ls)
      yield* Effect.logInfo("[CDK] Deploying...")

      const { process: cdkWatchProcess, events: cdkEvents } =
        yield* startCdkWatch(
          {
            profile: profileValue,
            region: regionValue,
            stacks: stacksFromOption,
            all,
          },
          serverScope,
        )

      // Track running Docker containers by function name
      const containers = yield* Ref.make<Map<string, FunctionContainer>>(
        new Map(),
      )

      // Track running Node.js workers by function name
      const workers = yield* Ref.make<Map<string, NodejsWorker>>(new Map())

      // Track registered functions (for lazy container/worker startup)
      const registeredFunctions = yield* Ref.make<
        Map<string, DiscoveredFunction>
      >(new Map())

      // Track Docker functions with active file watchers
      const watchedDockerFunctions = new Set<string>()

      // Invocation tracking for improved logging output
      const invocationCounter = yield* Ref.make<number>(0)
      // Use a plain Map for invocation contexts so it can be accessed from stream callbacks
      const invocationContexts = new Map<string, InvocationContext>()

      // Project root is the current working directory (where CDK app lives)
      const projectRoot = process.cwd()

      let appSyncClient: ReturnType<typeof makeAppSyncClient> | null = null

      // Track if we've logged the "Watching" message (only log once)
      const logState = { hasLoggedWatching: false, hasDiscoveredOnce: false }

      // Function to start/update the daemon with discovered functions
      const startOrUpdateDaemon = Effect.gen(function* () {
        // Only show "Discovering functions..." on first run
        if (!logState.hasDiscoveredOnce) {
          yield* Effect.logInfo("[Local] Discovering functions...")
        }

        // Get AppSync endpoints (may need to wait for first deploy)
        if (!appSyncClient) {
          yield* Effect.logDebug(
            "[Local] Reading AppSync endpoints from SSM...",
          )
          const endpoints = yield* getAppSyncEndpoints(qualifier).pipe(
            Effect.retry({ times: 10, schedule: Schedule.spaced("3 seconds") }),
          )
          yield* Effect.logDebug(
            `[Local] HTTP endpoint: ${endpoints.httpEndpoint}`,
          )
          appSyncClient = makeAppSyncClient(endpoints)
        }

        // Discover functions (filtered to stacks in this CDK project)
        yield* Effect.logDebug("[Local] Discovering Lambda functions...")
        const functions = yield* discoverFunctions(filterState.stacks)

        if (functions.length === 0) {
          yield* Effect.logInfo(
            "[Local] No functions found with live-lambda tags yet.",
          )
          return
        }

        const currentRegistered = yield* Ref.get(registeredFunctions)

        // Collect new functions to register
        const newFunctions: Array<{
          fn: DiscoveredFunction
          isDocker: boolean
        }> = []

        for (const fn of functions) {
          const isDocker = Boolean(fn.dockerContextPath)
          const isNodejs = !isDocker && Boolean(fn.localHandler)

          if (!isDocker && !isNodejs) {
            yield* Effect.logDebug(
              `[Local] Skipping ${fn.functionName} - no Docker context or local handler`,
            )
            continue
          }

          if (currentRegistered.has(fn.functionName)) {
            yield* Effect.logDebug(
              `[Local] Already watching ${fn.functionName}`,
            )
            continue
          }

          newFunctions.push({ fn, isDocker })
        }

        // Print summary of discovered functions
        if (newFunctions.length > 0) {
          const summary = newFunctions
            .map(({ fn, isDocker }) => {
              const mode = isDocker ? "docker" : "node"
              const shortName = fn.functionName.includes("-")
                ? fn.functionName.split("-").slice(-2, -1)[0] || fn.functionName
                : fn.functionName
              return `${shortName} (${mode})`
            })
            .join(", ")
          // Use different message for first discovery vs subsequent
          const prefix = logState.hasDiscoveredOnce
            ? "[Local] Functions added:"
            : "[Local] Functions:"
          yield* Effect.logInfo(`${prefix} ${summary}`)
        }

        // Register functions and set up subscriptions
        for (const { fn, isDocker } of newFunctions) {
          yield* Effect.logDebug(
            `[Local] Registering ${fn.functionName} (${isDocker ? "Docker" : "Node.js"})`,
          )

          // Register the function
          currentRegistered.set(fn.functionName, fn)

          // Subscribe to invocations for this function
          const invocationChannel = buildChannelName.invocation(fn.functionName)
          yield* Effect.logDebug(
            `[Local] Subscribing to invocations for ${fn.functionName}`,
          )

          // Subscribe using forkDaemon to run independently with context preserved
          // Route to Docker or Node.js handler based on function type
          if (isDocker) {
            yield* appSyncClient!
              .subscribeToInvocations(invocationChannel)
              .pipe(
                Stream.runForEach((invocation) =>
                  handleDockerInvocation(
                    fn,
                    invocation,
                    containers,
                    serverScope,
                    projectRoot,
                    idleTimeout,
                    effectivePollTimeout,
                    appSyncClient!,
                    invocationCounter,
                    invocationContexts,
                  ).pipe(
                    Effect.catchAll((error) =>
                      Effect.logError(
                        `[Local] Docker invocation error: ${error}`,
                      ),
                    ),
                  ),
                ),
                Effect.forkDaemon,
              )
          } else {
            yield* appSyncClient!
              .subscribeToInvocations(invocationChannel)
              .pipe(
                Stream.runForEach((invocation) =>
                  handleNodejsInvocation(
                    fn,
                    invocation,
                    workers,
                    serverScope,
                    projectRoot,
                    appSyncClient!,
                    invocationCounter,
                    invocationContexts,
                  ).pipe(
                    Effect.catchAll((error) =>
                      Effect.logError(
                        `[Local] Node.js invocation error: ${error}`,
                      ),
                    ),
                  ),
                ),
                Effect.forkDaemon,
              )
          }
        }

        yield* Ref.set(registeredFunctions, currentRegistered)

        // Start file watchers for new Docker functions
        const newDockerFunctions: WatchedDockerFunction[] = []
        for (const fn of functions) {
          if (
            fn.dockerContextPath &&
            !watchedDockerFunctions.has(fn.functionName)
          ) {
            // Resolve the context path
            const contextPath = fn.dockerContextPath.startsWith("/")
              ? fn.dockerContextPath
              : `${projectRoot}/${fn.dockerContextPath}`

            newDockerFunctions.push({
              functionId: fn.functionName,
              dockerContextPath: contextPath,
            })
            watchedDockerFunctions.add(fn.functionName)
          }
        }

        // Start watching new Docker contexts
        if (newDockerFunctions.length > 0) {
          yield* Effect.logDebug(
            `[Local] Starting file watchers for ${newDockerFunctions.length} Docker function(s)...`,
          )

          // Fork a daemon fiber to handle file change events with context preserved
          yield* watchDockerContexts(newDockerFunctions, 500).pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                yield* Effect.logDebug(
                  `[Local] File changed in ${event.functionId}: ${event.filePath}`,
                )
                yield* rebuildDockerContainer(
                  event.functionId,
                  containers,
                  projectRoot,
                ).pipe(
                  Effect.catchAll((error) =>
                    Effect.logError(
                      `[Local] Rebuild failed for ${event.functionId}: ${error}`,
                    ),
                  ),
                )
              }),
            ),
            Effect.forkDaemon,
          )
        }

        if (!logState.hasLoggedWatching) {
          logState.hasLoggedWatching = true
          yield* Effect.logInfo("[Local] Ready for invocations")
        }

        // Mark that we've completed first discovery
        logState.hasDiscoveredOnce = true
      })

      // Handle CDK watch events (stack discovery and deploy completion)
      yield* Queue.take(cdkEvents).pipe(
        Effect.flatMap((event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "StackDiscovered":
                // Add discovered stack to filter (if not using --stacks)
                if (
                  !stacksFromOption &&
                  !filterState.stacks.includes(event.stackName)
                ) {
                  filterState.stacks.push(event.stackName)
                  yield* Effect.logDebug(
                    `[Local] Discovered stack: ${event.stackName}`,
                  )
                }
                break
              case "DeployComplete":
                // Run daemon update on deploy completion
                yield* startOrUpdateDaemon.pipe(
                  Effect.catchAll((error) =>
                    Effect.logError(`Failed to update daemon: ${error}`),
                  ),
                )
                break
            }
          }),
        ),
        Effect.forever,
        Effect.fork,
      )

      // Handle cleanup on exit
      const cleanup = async () => {
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.logInfo("\nShutting down...")

            // Stop CDK watch
            yield* cdkWatchProcess
              .kill("SIGTERM")
              .pipe(Effect.catchAll(() => Effect.void))

            // Stop all Docker containers using the Docker service
            const docker = yield* Docker
            const currentContainers = yield* Ref.get(containers)
            for (const [name, container] of currentContainers) {
              yield* Effect.logInfo(`Stopping container: ${name}`)
              yield* docker.stop(container.containerName).pipe(
                Effect.scoped,
                Effect.catchAll(() => Effect.void),
              )
            }

            // Stop all Node.js workers
            const currentWorkers = yield* Ref.get(workers)
            for (const [name, worker] of currentWorkers) {
              yield* Effect.logInfo(`Stopping worker: ${name}`)
              yield* Effect.try(() =>
                worker.workerProcess.kill("SIGTERM"),
              ).pipe(Effect.catchAll(() => Effect.void))
            }

            // Close the server scope to clean up Runtime API servers
            yield* Scope.close(serverScope, Exit.void)
          }).pipe(
            Effect.provide(DockerLive),
            Effect.provide(BunContext.layer),
            Effect.provide(Logger.pretty),
            Effect.provide(Logger.minimumLogLevel(logLevel)),
          ),
        )

        process.exit(0)
      }

      process.on("SIGINT", cleanup)
      process.on("SIGTERM", cleanup)

      yield* Effect.logInfo("[Local] Press Ctrl+C to stop")

      // Keep the process running
      yield* Effect.never
    }).pipe(
      Effect.provide(Logger.pretty),
      Effect.provide(Logger.minimumLogLevel(logLevel)),
    )
  },
).pipe(
  Command.withDescription(
    "Start local Lambda development with CDK watch and Docker containers",
  ),
)
