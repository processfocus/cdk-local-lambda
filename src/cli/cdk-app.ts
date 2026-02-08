#!/usr/bin/env node

/**
 * CDK app entry point for bootstrap deployment.
 *
 * This file is used by CDK CLI to deploy the CdkLocalLambdaBootstrapStack.
 * CDK CLI sets CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION based on the
 * profile or environment before running this app.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Dynamically import the bootstrap stack, handling both compiled (.js) and source (.ts) cases.
 */
async function loadBootstrapStack() {
  // Try compiled version first (lib/bootstrap-stack/)
  const libPath = path.join(
    __dirname,
    "..",
    "..",
    "lib",
    "bootstrap-stack",
    "bootstrap-stack.js",
  )
  if (fs.existsSync(libPath)) {
    // @ts-expect-error - Path exists at runtime after compilation
    return import("../../lib/bootstrap-stack/bootstrap-stack.js")
  }

  // Fall back to source version (src/bootstrap-stack/) using direct path resolution
  const srcPath = path.join(
    __dirname,
    "..",
    "bootstrap-stack",
    "bootstrap-stack.ts",
  )
  if (fs.existsSync(srcPath)) {
    // Use file URL for cross-platform compatibility with Node.js type stripping
    const fileUrl = `file://${srcPath}`
    return import(fileUrl)
  }

  throw new Error("Cannot find bootstrap-stack module in lib/ or src/")
}

async function main() {
  const { CdkLocalLambdaBootstrapStack } = await loadBootstrapStack()

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
}

main().catch((error) => {
  console.error("Failed to run CDK app:", error)
  process.exit(1)
})
