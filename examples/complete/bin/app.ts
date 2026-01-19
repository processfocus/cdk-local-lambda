#!/usr/bin/env bun
/**
 * CDK App entry point for the complete example.
 *
 * This example demonstrates a DockerImageFunction with LiveLambdaAspect.
 * Deploy with CDK_LIVE=true to enable live debugging.
 *
 * IMPORTANT: The bootstrap import MUST be first, before any CDK imports!
 * This installs hooks to capture DockerImageFunction context paths.
 */

// Install the hook FIRST - before any CDK imports
// This patches Module._load to intercept aws-cdk-lib/aws-lambda and aws-lambda-nodejs
import "local-live-lambda/lib/aspect/live-lambda-bootstrap.js"

import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "local-live-lambda"
import { CompleteStack } from "../lib/complete-stack.js"

const app = new cdk.App()

new CompleteStack(app, "CompleteExampleStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})

// Apply LiveLambdaAspect when CDK_LIVE=true
// This transforms all Lambda functions to use the bridge handler
applyLiveLambdaAspect(app)

app.synth()
