#!/usr/bin/env node

/**
 * Effect CLI entry point for cdk-local-lambda.
 *
 * Commands:
 * - bootstrap: Deploy the CdkLocalLambdaBootstrapStack
 * - local: Run Lambda functions locally using Docker
 */

import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
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

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
