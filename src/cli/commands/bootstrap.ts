import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import {
  BOOTSTRAP_STACK_NAME,
  BOOTSTRAP_VERSION,
  SSM_BASE_PATH,
} from "../../shared/types.js"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Get the path to the CDK app file.
 * When running from lib/, use the sibling cdk-app.js.
 * When running from src/, fall back to the sibling cdk-app.ts.
 */
function getCdkAppPath(): string {
  // Check for compiled version in same directory (lib/cli/)
  const jsPath = path.join(__dirname, "..", "cdk-app.js")
  if (fs.existsSync(jsPath)) {
    return jsPath
  }
  // Fall back to TypeScript source for local development (src/cli/)
  return path.join(__dirname, "..", "cdk-app.ts")
}

// Common options
const profileOption = Options.text("profile").pipe(
  Options.optional,
  Options.withDescription("AWS profile to use"),
)

const regionOption = Options.text("region").pipe(
  Options.optional,
  Options.withDescription("AWS region to deploy to"),
)

/**
 * Get the currently deployed bootstrap version from SSM.
 * Returns undefined if not deployed or parameter doesn't exist.
 */
function getDeployedVersion(
  profile: Option.Option<string>,
  region: Option.Option<string>,
): string | undefined {
  const env = { ...process.env }
  if (Option.isSome(region)) {
    env.AWS_REGION = region.value
    env.CDK_DEFAULT_REGION = region.value
  }

  const args = [
    "ssm",
    "get-parameter",
    "--name",
    `${SSM_BASE_PATH}/hnb659fds/version`,
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]
  if (Option.isSome(profile)) {
    args.push("--profile", profile.value)
  }

  try {
    const result = execSync(`aws ${args.join(" ")}`, {
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return result.trim()
  } catch {
    return undefined
  }
}

/**
 * Bootstrap command - deploys the CdkLocalLambdaBootstrapStack
 * Only deploys if the required version is newer than the deployed version.
 * Skips deployment if deployed version is already equal or newer.
 */
export const bootstrapCommand = Command.make(
  "bootstrap",
  { profile: profileOption, region: regionOption },
  ({ profile, region }) =>
    Effect.gen(function* () {
      yield* Console.log("Checking bootstrap stack version...")

      const deployedVersion = getDeployedVersion(profile, region)
      const requiredVersion = BOOTSTRAP_VERSION

      if (deployedVersion) {
        const deployed = parseInt(deployedVersion, 10)
        const required = parseInt(requiredVersion, 10)

        if (deployed >= required) {
          yield* Console.log(
            `Bootstrap stack version ${deployedVersion} is already deployed (required: ${requiredVersion}). Skipping deployment.`,
          )
          return
        }
        yield* Console.log(
          `Upgrading bootstrap stack from version ${deployedVersion} to ${requiredVersion}...`,
        )
      } else {
        yield* Console.log(
          `No bootstrap stack found. Deploying version ${requiredVersion}...`,
        )
      }

      // Path to the CDK app that defines the bootstrap stack
      const cdkAppPath = getCdkAppPath()

      // Build CDK deploy command with options
      const args = [
        "npx",
        "cdk",
        "deploy",
        BOOTSTRAP_STACK_NAME,
        "--app",
        `"node ${cdkAppPath}"`,
        "--require-approval",
        "never",
      ]

      if (Option.isSome(profile)) {
        args.push("--profile", profile.value)
      }

      // Build environment with optional region
      const env = { ...process.env }
      if (Option.isSome(region)) {
        env.AWS_REGION = region.value
        env.CDK_DEFAULT_REGION = region.value
      }

      const command = args.join(" ")
      yield* Console.log(`Running: ${command}`)

      // Execute CDK deploy synchronously so output is streamed
      yield* Effect.try({
        try: () => {
          execSync(command, {
            stdio: "inherit",
            env,
          })
        },
        catch: (error) => {
          if (error instanceof Error) {
            return new Error(`CDK deploy failed: ${error.message}`)
          }
          return new Error("CDK deploy failed with unknown error")
        },
      })

      yield* Console.log("Bootstrap stack deployed successfully!")
    }),
).pipe(Command.withDescription("Deploy the Live Lambda bootstrap stack to AWS"))
