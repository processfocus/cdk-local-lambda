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
  /** Map of requestId -> response resolver */
  pendingResponses: Map<
    string,
    {
      resolve: (response: ResponseMessage) => void
    }
  >
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
 * Handle incoming invocations for a function by queueing them.
 */
const handleInvocation = (
  container: FunctionContainer,
  invocation: InvocationMessage,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log(
      `[Local] Queueing invocation ${invocation.requestId} for ${container.fn.functionName}`,
    )

    const lambdaInvocation: LambdaInvocation = {
      requestId: invocation.requestId,
      event: invocation.event,
      invokedFunctionArn: invocation.context.invokedFunctionArn,
      deadlineMs: Date.now() + invocation.context.getRemainingTimeInMillis,
      functionName: container.fn.functionName,
      functionVersion: invocation.context.functionVersion,
      memoryLimitMB: container.fn.memoryMB,
      logGroupName: invocation.context.logGroupName,
      logStreamName: invocation.context.logStreamName,
    }

    yield* queueInvocation(container.runtimeState, lambdaInvocation)
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
  const args = ["cdk", "watch", "--hotswap-fallback", "--no-logs"]

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

  // Pattern to detect deploy completion in CDK watch output
  // CDK outputs "✅  StackName" or "Deployment time:" when deploy completes
  const deployCompletePattern = /✅\s+\S+|Deployment time:/

  const processOutput = (data: Buffer) => {
    const text = data.toString()
    process.stdout.write(text)

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

      // Track running containers by function name
      const containers = yield* Ref.make<Map<string, FunctionContainer>>(
        new Map(),
      )

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

        const currentContainers = yield* Ref.get(containers)

        // Start containers for new Docker functions
        for (const fn of functions) {
          if (!fn.dockerContextPath) {
            yield* Console.log(
              `[Local] Skipping ${fn.functionName} - no Docker context (non-Docker function)`,
            )
            continue
          }

          if (currentContainers.has(fn.functionName)) {
            yield* Console.log(
              `[Local] Container already running for ${fn.functionName}`,
            )
            continue
          }

          yield* Console.log(
            `[Local] Found: ${fn.functionName} -> Docker context: ${fn.dockerContextPath}`,
          )

          // Create Runtime API server on ephemeral port
          // The server is scoped to serverScope which lives for the program duration
          const { port, state: runtimeState } =
            yield* startRuntimeApiServer().pipe(
              Effect.provideService(Scope.Scope, serverScope),
            )

          // Generate container name (must match what makeLambdaContainerConfig uses)
          const containerName = `lambda-${fn.functionName.replace(/[^a-zA-Z0-9]/g, "-")}`

          // Build and start the container from local Docker context
          const containerFiber = yield* startFunctionContainer(
            fn,
            port,
            projectRoot,
          ).pipe(
            Effect.catchAll((error) => {
              Console.error(
                `[Local] Failed to start container for ${fn.functionName}: ${error}`,
              )
              return Effect.fail(error)
            }),
          )

          const container: FunctionContainer = {
            fn,
            runtimeState,
            port,
            containerFiber,
            containerName,
            pendingResponses: new Map(),
          }

          // Start processing responses in the background using runFork
          Effect.runFork(processContainerResponses(container, appSyncClient!))

          currentContainers.set(fn.functionName, container)

          // Subscribe to invocations for this function
          const invocationChannel = buildChannelName.invocation(fn.functionName)
          yield* Console.log(
            `[Local] Subscribing to invocations for ${fn.functionName}`,
          )

          // Subscribe using runFork to run independently
          Effect.runFork(
            appSyncClient!
              .subscribeToInvocations(invocationChannel)
              .pipe(
                Stream.runForEach((invocation) =>
                  handleInvocation(container, invocation).pipe(
                    Effect.catchAll((error) =>
                      Console.error(`[Local] Invocation error: ${error}`),
                    ),
                  ),
                ),
              ),
          )
        }

        yield* Ref.set(containers, currentContainers)
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
