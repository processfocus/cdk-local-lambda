#!/usr/bin/env bun

/**
 * Effect CLI entry point for local-live-lambda.
 *
 * Commands:
 * - bootstrap: Deploy the CdkLocalLambdaBootstrapStack
 * - local: Run Lambda functions locally using Docker
 */

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { bootstrapCommand } from "./commands/bootstrap.js"
import { localCommand } from "./commands/local.js"

/**
 * Root command
 */
const rootCommand = Command.make("local-lambda", {}).pipe(
  Command.withSubcommands([bootstrapCommand, localCommand]),
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
