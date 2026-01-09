#!/usr/bin/env bun

/**
 * Effect CLI entry point for local-live-lambda.
 *
 * Commands:
 * - bootstrap: Deploy the CdkLocalLambdaBootstrapStack
 * - daemon: Start the local daemon (stub)
 */

import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { bootstrapCommand } from "./commands/bootstrap.js"

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
 * Daemon command stub
 */
const daemonCommand = Command.make(
  "daemon",
  { profile: profileOption, region: regionOption },
  () =>
    Effect.gen(function* () {
      yield* Console.error("Daemon not yet implemented")
      yield* Effect.fail(new Error("Daemon not yet implemented"))
    }),
).pipe(
  Command.withDescription(
    "Start the local Lambda daemon (not yet implemented)",
  ),
)

/**
 * Root command
 */
const rootCommand = Command.make("local-lambda", {}).pipe(
  Command.withSubcommands([bootstrapCommand, daemonCommand]),
  Command.withDescription("CLI for developing AWS Lambda functions locally"),
)

/**
 * Run the CLI
 */
const cli = Command.run(rootCommand, {
  name: "local-lambda",
  version: "0.1.0",
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
