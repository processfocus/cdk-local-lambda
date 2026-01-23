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

import { type ChildProcess, execSync, spawn } from "node:child_process"
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
  Console,
  Effect,
  Exit,
  type Fiber,
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
  buildDockerImage,
  detectDockerRuntime,
  makeLambdaContainerConfig,
  runDockerContainer,
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
      yield* Console.log("[Local] Bootstrap stack version parameter not found.")
      return false
    }

    if (result !== BOOTSTRAP_VERSION) {
      yield* Console.log(
        `[Local] Bootstrap stack version mismatch: found ${result}, expected ${BOOTSTRAP_VERSION}`,
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
    yield* Console.log("[Local] Running bootstrap stack deployment...")

    // Resolve the CDK app path relative to this module
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const cdkAppPath = path.resolve(__dirname, "..", "cdk-app.js")

    const args = [
      "npx",
      "cdk",
      "deploy",
      BOOTSTRAP_STACK_NAME,
      "--require-approval",
      "never",
      "--app",
      `"bun ${cdkAppPath}"`,
    ]

    if (options.profile) {
      args.push("--profile", options.profile)
    }

    const env: NodeJS.ProcessEnv = { ...process.env }
    if (options.region) {
      env.AWS_REGION = options.region
      env.CDK_DEFAULT_REGION = options.region
    }

    const command = args.join(" ")
    yield* Console.log(`[Local] Running: ${command}`)

    yield* Effect.try({
      try: () => {
        execSync(command, { stdio: "inherit", env, shell: "/bin/bash" })
      },
      catch: (error) => {
        if (error instanceof Error) {
          return new Error(`Bootstrap deployment failed: ${error.message}`)
        }
        return new Error("Bootstrap deployment failed with unknown error")
      },
    })

    yield* Console.log("[Local] Bootstrap stack deployed successfully!")
  })

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
    yield* Console.log("[Local] Checking bootstrap stack version...")

    const versionOk = yield* checkBootstrapVersion(options.qualifier)

    if (!versionOk) {
      yield* Console.log(
        "[Local] Bootstrap stack needs to be deployed or updated.",
      )
      yield* runBootstrap({ profile: options.profile, region: options.region })
    } else {
      yield* Console.log("[Local] Bootstrap stack version OK.")
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
 * Uses Effect.runFork to ensure the container runs independently.
 */
const startFunctionContainer = (
  fn: DiscoveredFunction,
  port: number,
  projectRoot: string,
): Effect.Effect<Fiber.RuntimeFiber<void, Error>, Error> =>
  Effect.gen(function* () {
    if (!fn.dockerContextPath) {
      return yield* Effect.fail(
        new Error(`Function ${fn.functionName} has no Docker context path`),
      )
    }

    const dockerRuntime = yield* detectDockerRuntime()
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
    yield* buildDockerImage({
      contextPath,
      imageName,
      platform,
    })

    const containerConfig = makeLambdaContainerConfig({
      imageUri: imageName,
      runtimeApiHost,
      runtimeApiPort: port,
      functionName: fn.functionName,
      functionVersion: "$LATEST",
      memoryMB: fn.memoryMB,
      timeoutSeconds: 3600, // Long timeout - container stays running
      platform,
    })

    console.log(
      `[Local] Starting container for ${fn.functionName} on port ${port}`,
    )

    // Use Effect.runFork to run the container completely independently
    const fiber = Effect.runFork(
      runDockerContainer(containerConfig).pipe(
        Effect.map(() => undefined as void),
      ),
    )

    return fiber
  })

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
 * Process responses from a container and dispatch to waiting callers.
 */
const processContainerResponses = (
  container: FunctionContainer,
  client: ReturnType<typeof makeAppSyncClient>,
) =>
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
        yield* Console.error(
          `[Local] Init error: ${result.errorType}: ${result.errorMessage}`,
        )
        continue
      } else {
        continue
      }

      // Send response back via AppSync
      yield* client.publishResponse(responseChannel, response)
      yield* Console.log(`[Local] Sent response for ${response.requestId}`)
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

    // Build environment for the worker process
    // Use env from invocation (AWS credentials, user-defined vars) + local overrides
    // We need PATH from local environment for the bun executable to be found
    const workerEnv: NodeJS.ProcessEnv = {
      // Start with env vars from the bridge Lambda (AWS credentials, user-defined vars)
      ...env,
      // Local system vars needed for execution (PATH for finding bun, HOME for configs)
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Local overrides
      AWS_LAMBDA_RUNTIME_API: `localhost:${port}`,
      _HANDLER: fn.localHandler,
      LAMBDA_TASK_ROOT: projectRoot,
      // Memory limit for context object
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(fn.memoryMB),
    }

    yield* Console.log(
      `[Local] Starting Node.js worker for ${fn.functionName} on port ${port}`,
    )
    yield* Console.log(`[Local] Handler: ${fn.localHandler}`)

    // Spawn Bun with --watch to automatically restart when handler files change
    // This enables hot-reload without needing to restart the daemon
    const workerProcess = spawn("bun", ["--watch", runtimeWrapperPath], {
      cwd: projectRoot,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Forward stdout/stderr with function name prefix
    workerProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n")
      for (const line of lines) {
        console.log(`[${fn.functionName}] ${line}`)
      }
    })

    workerProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n")
      for (const line of lines) {
        console.error(`[${fn.functionName}] ${line}`)
      }
    })

    workerProcess.on("error", (err) => {
      console.error(
        `[Local] Worker error for ${fn.functionName}: ${err.message}`,
      )
    })

    workerProcess.on("close", (code) => {
      console.log(
        `[Local] Worker for ${fn.functionName} exited with code ${code}`,
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
        yield* Console.error(
          `[Local] Worker init error: ${result.errorType}: ${result.errorMessage}`,
        )
        continue
      } else {
        continue
      }

      // Send response back via AppSync
      yield* client.publishResponse(responseChannel, response)
      yield* Console.log(`[Local] Sent response for ${response.requestId}`)
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
): Effect.Effect<NodejsWorker, Error> =>
  Effect.gen(function* () {
    // Check if worker already exists
    const currentWorkers = yield* Ref.get(workersRef)
    const existing = currentWorkers.get(fn.functionName)
    if (existing) {
      return existing
    }

    // Worker doesn't exist - start it lazily
    yield* Console.log(
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
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Remove broken worker from map on failure
          yield* Console.error(
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
    Effect.runFork(processWorkerResponses(worker, appSyncClient))

    return worker
  })

/**
 * Ensure a container is started for a function.
 * If the container already exists, return it.
 * Otherwise, create the Runtime API server, add to containers map, and start the container.
 */
const ensureContainerStarted = (
  fn: DiscoveredFunction,
  containersRef: Ref.Ref<Map<string, FunctionContainer>>,
  serverScope: Scope.Scope,
  projectRoot: string,
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
): Effect.Effect<FunctionContainer, Error> =>
  Effect.gen(function* () {
    // Check if container already exists
    const currentContainers = yield* Ref.get(containersRef)
    const existing = currentContainers.get(fn.functionName)
    if (existing) {
      return existing
    }

    // Container doesn't exist - start it lazily
    yield* Console.log(
      `[Local] Starting container for first invocation of ${fn.functionName}...`,
    )

    // Create Runtime API server on ephemeral port
    const { port, state: runtimeState } = yield* startRuntimeApiServer().pipe(
      Effect.provideService(Scope.Scope, serverScope),
    )

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
    }

    // Add to map immediately to prevent race conditions
    currentContainers.set(fn.functionName, container)
    yield* Ref.set(containersRef, currentContainers)

    // Build and start the container - remove from map on failure
    const containerFiber = yield* startFunctionContainer(
      fn,
      port,
      projectRoot,
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Remove broken container from map on failure
          yield* Console.error(
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

    // Start processing responses in the background
    Effect.runFork(processContainerResponses(container, appSyncClient))

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
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const containers = yield* Ref.get(containersRef)
    const container = containers.get(functionId)

    if (!container) {
      yield* Console.log(
        `[Local] Cannot rebuild ${functionId} - container not found`,
      )
      return
    }

    // Mark as rebuilding - invocations will still queue but we log it
    container.isRebuilding = true

    yield* Console.log(`[Local] Rebuilding container for ${functionId}...`)

    // Stop the existing container
    const containerId = container.containerName
    yield* Console.log(
      `[Local] Stopping container with name prefix: ${containerId}`,
    )

    const stopResult = yield* Effect.try(() => {
      // First list matching containers
      const containers = execSync(
        `docker ps -q --filter "name=${containerId}"`,
        { encoding: "utf-8" },
      ).trim()

      if (containers) {
        console.log(
          `[Local] Found containers to stop: ${containers.replace(/\n/g, ", ")}`,
        )
        execSync(`docker stop ${containers.replace(/\n/g, " ")}`, {
          stdio: "inherit",
        })
        return "stopped"
      }
      return "none"
    }).pipe(
      Effect.catchAll((error) => {
        console.log(`[Local] Note: Container stop had issue: ${error}`)
        return Effect.succeed("error")
      }),
    )
    yield* Console.log(`[Local] Container stop result: ${stopResult}`)

    // Resolve the context path
    const fn = container.fn
    const contextPath = fn.dockerContextPath?.startsWith("/")
      ? fn.dockerContextPath
      : `${projectRoot}/${fn.dockerContextPath}`

    // Determine platform from architecture
    const platform = fn.architecture === "arm64" ? "linux/arm64" : "linux/amd64"

    // Rebuild the Docker image
    yield* buildDockerImage({
      contextPath,
      imageName: container.imageName,
      platform,
    })

    // Restart the container by triggering container startup
    // The existing fiber will have exited when we stopped the container
    // We need to start a new one
    const dockerRuntime = yield* detectDockerRuntime()
    const runtimeApiHost = dockerRuntime.isDockerDesktop
      ? "host.docker.internal"
      : "runtime.api"

    yield* Console.log(
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
    yield* Console.log(`[Local] Starting new container for ${functionId}...`)

    const newFiber = Effect.runFork(
      runDockerContainer(containerConfig).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.exitCode !== 0) {
              console.error(
                `[Local] Container for ${functionId} exited with code ${result.exitCode}`,
              )
              console.error(`[Local] stderr: ${result.stderr}`)
            }
          }),
        ),
        Effect.map(() => undefined as void),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(`[Local] Container error for ${functionId}: ${error}`)
          }),
        ),
      ),
    )

    // Update the container state with the new fiber
    container.containerFiber = newFiber

    // Wait a moment for the container to start and begin polling
    yield* Effect.sleep("2 seconds")

    container.isRebuilding = false
    yield* Console.log(`[Local] Container rebuilt for ${functionId}`)
  })

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
  appSyncClient: ReturnType<typeof makeAppSyncClient>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // Ensure container is started (lazy startup on first invocation)
    const container = yield* ensureContainerStarted(
      fn,
      containersRef,
      serverScope,
      projectRoot,
      appSyncClient,
    )

    // Log if queuing during a rebuild
    if (container.isRebuilding) {
      yield* Console.log(
        `[Local] Queueing invocation ${invocation.requestId} for ${fn.functionName} (rebuild in progress, will be picked up by new container)`,
      )
    } else {
      yield* Console.log(
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

    yield* Console.log(
      `[Local] Queueing to Runtime API on port ${container.port}`,
    )
    yield* queueInvocation(container.runtimeState, lambdaInvocation)
    yield* Console.log(`[Local] Invocation queued successfully`)
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
    )

    yield* Console.log(
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
 * List all CDK stack names in the current project.
 * Uses `cdk list` to get stack names from the CDK app.
 */
const listCdkStacks = (options: {
  profile?: string
  region?: string
}): Effect.Effect<string[], Error> =>
  Effect.gen(function* () {
    const args = ["cdk", "list"]

    if (options.profile) {
      args.push("--profile", options.profile)
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
    }

    if (options.region) {
      env.AWS_REGION = options.region
      env.CDK_DEFAULT_REGION = options.region
    }

    yield* Console.log("[Local] Discovering CDK stacks in project...")

    const output = yield* Effect.try({
      try: () =>
        execSync(`npx ${args.join(" ")}`, {
          encoding: "utf-8",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: (error) =>
        new Error(`Failed to list CDK stacks: ${String(error)}`),
    })

    const stacks = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    yield* Console.log(`[Local] Found stacks: ${stacks.join(", ")}`)

    return stacks
  })

/**
 * Start CDK watch process with CDK_LIVE=true.
 */
const startCdkWatch = (options: {
  profile?: string
  region?: string
  stacks?: string[]
  onDeployComplete: () => void
}): ChildProcess => {
  const args = [
    "cdk",
    "watch",
    "--hotswap-fallback",
    "--no-logs",
    "--method=direct",
  ]

  if (options.stacks && options.stacks.length > 0) {
    args.push(...options.stacks)
  } else {
    args.push("--all")
  }

  if (options.profile) {
    args.push("--profile", options.profile)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CDK_LIVE: "true",
  }

  if (options.region) {
    env.AWS_REGION = options.region
    env.CDK_DEFAULT_REGION = options.region
  }

  console.log(`[Local] Starting: npx ${args.join(" ")}`)

  const proc = spawn("npx", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    shell: true,
  })

  // Patterns to detect CDK watch behavior
  const deployCompletePattern = /✅\s+\S+|Deployment time:/
  const synthPattern = /Synthesizing|cdk\.out/i
  const hotswapPattern = /hotswap|Hotswapping/i
  const noChangesPattern = /no changes|identical|up to date/i
  const bundlingPattern = /Bundling|esbuild/i

  const processOutput = (data: Buffer) => {
    const text = data.toString()
    process.stdout.write(text)

    // Debug logging to understand CDK watch behavior
    if (bundlingPattern.test(text)) {
      console.log("[Local] CDK is bundling assets...")
    }
    if (synthPattern.test(text)) {
      console.log("[Local] CDK is synthesizing...")
    }
    if (hotswapPattern.test(text)) {
      console.log("[Local] CDK is attempting hotswap...")
    }
    if (noChangesPattern.test(text)) {
      console.log("[Local] CDK detected no changes")
    }

    // Check for deploy completion markers
    if (deployCompletePattern.test(text)) {
      console.log("[Local] Detected deploy completion")
      // Small delay to ensure AWS has propagated the changes
      setTimeout(() => options.onDeployComplete(), 1000)
    }
  }

  proc.stdout?.on("data", processOutput)
  proc.stderr?.on("data", (data: Buffer) => {
    // CDK watch may output to stderr as well
    processOutput(data)
  })

  proc.on("error", (err) => {
    console.error(`[Local] CDK watch error: ${err.message}`)
  })

  proc.on("close", (code) => {
    console.log(`[Local] CDK watch exited with code ${code}`)
  })

  return proc
}

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
  },
  ({ profile, region, qualifier, stacks }) =>
    Effect.gen(function* () {
      yield* Console.log("[Local] Starting local Lambda development...")

      const profileValue = profile._tag === "Some" ? profile.value : undefined
      const regionValue = region._tag === "Some" ? region.value : undefined
      const stacksFromOption =
        stacks._tag === "Some"
          ? stacks.value.split(",").map((s) => s.trim())
          : undefined

      if (profileValue) {
        process.env.AWS_PROFILE = profileValue
      }
      if (regionValue) {
        process.env.AWS_REGION = regionValue
      }

      // Get the list of stacks from the CDK project
      // If --stacks is provided, use that; otherwise discover all stacks in the project
      const projectStacks = yield* listCdkStacks({
        profile: profileValue,
        region: regionValue,
      })

      // Use provided stacks or all project stacks for filtering
      const stackFilter = stacksFromOption ?? projectStacks

      // Ensure bootstrap stack is deployed with correct version
      yield* ensureBootstrap({
        qualifier,
        profile: profileValue,
        region: regionValue,
      })

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

      // Project root is the current working directory (where CDK app lives)
      const projectRoot = process.cwd()

      let appSyncClient: ReturnType<typeof makeAppSyncClient> | null = null

      // Create a long-lived scope for all Runtime API servers
      // Servers will run until this scope is closed (when the program ends)
      const serverScope = yield* Scope.make()

      // Function to start/update the daemon with discovered functions
      const startOrUpdateDaemon = Effect.gen(function* () {
        // Get AppSync endpoints (may need to wait for first deploy)
        if (!appSyncClient) {
          yield* Console.log("[Local] Reading AppSync endpoints from SSM...")
          const endpoints = yield* getAppSyncEndpoints(qualifier).pipe(
            Effect.retry({ times: 10, schedule: Schedule.spaced("3 seconds") }),
          )
          yield* Console.log(`[Local] HTTP endpoint: ${endpoints.httpEndpoint}`)
          appSyncClient = makeAppSyncClient(endpoints)
        }

        // Discover functions (filtered to stacks in this CDK project)
        yield* Console.log("[Local] Discovering Lambda functions...")
        const functions = yield* discoverFunctions(stackFilter)

        if (functions.length === 0) {
          yield* Console.log(
            "[Local] No functions found with live-lambda tags yet.",
          )
          return
        }

        const currentRegistered = yield* Ref.get(registeredFunctions)

        // Register functions and set up subscriptions (containers/workers start lazily on first invocation)
        for (const fn of functions) {
          // Determine execution mode: Docker (has dockerContextPath) or Node.js (has localHandler only)
          const isDocker = Boolean(fn.dockerContextPath)
          const isNodejs = !isDocker && Boolean(fn.localHandler)

          if (!isDocker && !isNodejs) {
            yield* Console.log(
              `[Local] Skipping ${fn.functionName} - no Docker context or local handler`,
            )
            continue
          }

          if (currentRegistered.has(fn.functionName)) {
            yield* Console.log(`[Local] Already watching ${fn.functionName}`)
            continue
          }

          const mode = isDocker ? "Docker container" : "Node.js worker"
          yield* Console.log(
            `[Local] Registered: ${fn.functionName} (${mode} will start on first invocation)`,
          )

          // Register the function
          currentRegistered.set(fn.functionName, fn)

          // Subscribe to invocations for this function
          // Container/worker will be started lazily when first invocation arrives
          const invocationChannel = buildChannelName.invocation(fn.functionName)
          yield* Console.log(
            `[Local] Subscribing to invocations for ${fn.functionName}`,
          )

          // Subscribe using runFork to run independently
          // Route to Docker or Node.js handler based on function type
          if (isDocker) {
            Effect.runFork(
              appSyncClient!
                .subscribeToInvocations(invocationChannel)
                .pipe(
                  Stream.runForEach((invocation) =>
                    handleDockerInvocation(
                      fn,
                      invocation,
                      containers,
                      serverScope,
                      projectRoot,
                      appSyncClient!,
                    ).pipe(
                      Effect.catchAll((error) =>
                        Console.error(
                          `[Local] Docker invocation error: ${error}`,
                        ),
                      ),
                    ),
                  ),
                ),
            )
          } else {
            Effect.runFork(
              appSyncClient!
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
                    ).pipe(
                      Effect.catchAll((error) =>
                        Console.error(
                          `[Local] Node.js invocation error: ${error}`,
                        ),
                      ),
                    ),
                  ),
                ),
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
          yield* Console.log(
            `[Local] Starting file watchers for ${newDockerFunctions.length} Docker function(s)...`,
          )

          // Fork a fiber to handle file change events
          Effect.runFork(
            watchDockerContexts(newDockerFunctions, 500).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  yield* Console.log(
                    `[Local] File changed in ${event.functionId}: ${event.filePath}`,
                  )
                  yield* rebuildDockerContainer(
                    event.functionId,
                    containers,
                    projectRoot,
                  ).pipe(
                    Effect.catchAll((error) =>
                      Console.error(
                        `[Local] Rebuild failed for ${event.functionId}: ${error}`,
                      ),
                    ),
                  )
                }),
              ),
            ),
          )
        }

        yield* Console.log("[Local] Watching for invocations...")
      })

      // Start CDK watch with deploy completion callback
      let cdkWatchProc: ChildProcess | null = null

      const onDeployComplete = () => {
        console.log("[Local] Deploy completed, re-discovering functions...")
        Effect.runPromise(
          startOrUpdateDaemon.pipe(
            Effect.catchAll((error) =>
              Effect.sync(() =>
                console.error(`[Local] Failed to update daemon: ${error}`),
              ),
            ),
          ),
        )
      }

      cdkWatchProc = startCdkWatch({
        profile: profileValue,
        region: regionValue,
        stacks: stacksFromOption,
        onDeployComplete,
      })

      // Start daemon immediately (will discover existing functions)
      // This runs in parallel with CDK watch's initial deploy
      yield* Console.log("[Local] Starting daemon...")
      yield* startOrUpdateDaemon.pipe(
        Effect.catchAll((error) =>
          Console.log(
            `[Local] Initial discovery: ${error.message} (will retry after deploy)`,
          ),
        ),
      )

      // Handle cleanup on exit
      const cleanup = async () => {
        console.log("\n[Local] Shutting down...")

        // Stop CDK watch
        if (cdkWatchProc) {
          cdkWatchProc.kill("SIGTERM")
        }

        // Stop all Docker containers
        // Note: Runtime API servers are managed by Effect scope and will be
        // cleaned up when the scope closes (process exit)
        const currentContainers = await Effect.runPromise(Ref.get(containers))
        for (const [name, container] of currentContainers) {
          console.log(`[Local] Stopping container: ${name}`)
          // Stop the Docker container (find by name prefix)
          try {
            execSync(
              `docker ps -q --filter "name=${container.containerName}" | xargs -r docker stop`,
              { stdio: "ignore" },
            )
          } catch {
            // Ignore errors - container may already be stopped
          }
        }

        // Stop all Node.js workers
        const currentWorkers = await Effect.runPromise(Ref.get(workers))
        for (const [name, worker] of currentWorkers) {
          console.log(`[Local] Stopping worker: ${name}`)
          try {
            worker.workerProcess.kill("SIGTERM")
          } catch {
            // Ignore errors - worker may already be stopped
          }
        }

        // Close the server scope to clean up Runtime API servers
        await Effect.runPromise(Scope.close(serverScope, Exit.void))

        process.exit(0)
      }

      process.on("SIGINT", cleanup)
      process.on("SIGTERM", cleanup)

      yield* Console.log("[Local] Press Ctrl+C to stop")

      // Keep the process running
      yield* Effect.never
    }),
).pipe(
  Command.withDescription(
    "Start local Lambda development with CDK watch and Docker containers",
  ),
)
