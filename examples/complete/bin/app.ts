#!/usr/bin/env bun
/**
 * CDK App entry point for the complete example.
 *
 * This example demonstrates a DockerImageFunction with LiveLambdaAspect.
 * Deploy with CDK_LIVE=true to enable live debugging.
 *
 * IMPORTANT: The bootstrap import MUST be first, before any CDK imports!
 * This installs hooks to capture DockerImageFunction context paths.
 *
 * NOTE: When running under Bun, automatic capture requires preloading the
 * bootstrap (Bun snapshots CJS named exports during static ESM import linking).
 * Use: `CDK_LIVE=true bun --preload cdk-local-lambda/bootstrap bin/app.ts`
 * If you can't use preload, live debugging won't work.
 */

// Install the hook FIRST - before any CDK imports
// This patches Module._load to intercept aws-cdk-lib/aws-lambda and aws-lambda-nodejs
// Note: In Bun, this only works reliably when preloaded (see note above).
import "cdk-local-lambda/bootstrap"

import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "cdk-local-lambda"
import { CompleteStack } from "../lib/complete-stack.js"

const app = new cdk.App()

new CompleteStack(app, "CompleteExampleStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})

// Apply LiveLambdaAspect when CDK_LIVE=true
// This transforms all supported Lambda functions to use the bridge handler.
applyLiveLambdaAspect(app, {})

app.synth()
