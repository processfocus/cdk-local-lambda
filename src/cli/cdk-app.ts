#!/usr/bin/env bun
/**
 * CDK app entry point for bootstrap deployment.
 *
 * This file is used by CDK CLI to deploy the CdkLocalLambdaBootstrapStack.
 * CDK CLI sets CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION based on the
 * profile or environment before running this app.
 */

import * as cdk from "aws-cdk-lib"
import { CdkLocalLambdaBootstrapStack } from "../bootstrap-stack/bootstrap-stack.js"

const app = new cdk.App()

// CDK CLI provides these env vars when using --profile or AWS credentials
const account = process.env.CDK_DEFAULT_ACCOUNT
const region = process.env.CDK_DEFAULT_REGION

new CdkLocalLambdaBootstrapStack(app, "CdkLocalLambdaBootstrapStack", {
  // Only set env if both account and region are available
  // Otherwise, CDK will use environment-agnostic deployment
  ...(account && region ? { env: { account, region } } : {}),
})

app.synth()
