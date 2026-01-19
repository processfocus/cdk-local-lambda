#!/usr/bin/env bun
/**
 * CDK app entry point for bootstrap deployment.
 *
 * This file is used by CDK CLI to deploy the CdkLocalLambdaBootstrapStack.
 */

import * as cdk from "aws-cdk-lib"
import { CdkLocalLambdaBootstrapStack } from "../bootstrap-stack/bootstrap-stack.js"

const app = new cdk.App()

// Get account and region from environment
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID
const region =
  process.env.CDK_DEFAULT_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION

if (!account || !region) {
  console.error("Error: AWS account and region must be configured.")
  console.error(
    "Set CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION, or use AWS CLI profile.",
  )
  console.error(`Current: account=${account}, region=${region}`)
  process.exit(1)
}

new CdkLocalLambdaBootstrapStack(app, "CdkLocalLambdaBootstrapStack", {
  env: { account, region },
})

app.synth()
