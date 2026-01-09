import { execSync } from "node:child_process"
import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { BOOTSTRAP_STACK_NAME } from "../../shared/types.js"

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
 * Bootstrap command - deploys the CdkLocalLambdaBootstrapStack
 */
export const bootstrapCommand = Command.make(
  "bootstrap",
  { profile: profileOption, region: regionOption },
  ({ profile, region }) =>
    Effect.gen(function* () {
      yield* Console.log("Deploying bootstrap stack...")

      // Build CDK deploy command with options
      const args = [
        "npx",
        "cdk",
        "deploy",
        BOOTSTRAP_STACK_NAME,
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
