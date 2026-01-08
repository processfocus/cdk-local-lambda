/**
 * CDK app entry point for bootstrap deployment.
 *
 * This file is used by CDK CLI to deploy the CdkLocalLambdaBootstrapStack.
 */

import * as cdk from "aws-cdk-lib"
import { CdkLocalLambdaBootstrapStack } from "../bootstrap-stack/bootstrap-stack.js"

const app = new cdk.App()
new CdkLocalLambdaBootstrapStack(app, "CdkLocalLambdaBootstrapStack")
