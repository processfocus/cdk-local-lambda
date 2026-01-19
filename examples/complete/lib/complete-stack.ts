/**
 * Complete example stack demonstrating DockerImageFunction with LiveLambdaAspect.
 *
 * This stack creates a simple echo Lambda function using a Bun-based Docker image.
 * When CDK_LIVE=true is set, the aspect transforms it to use the bridge handler.
 */

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import type { Construct } from "constructs"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface CompleteStackProps extends cdk.StackProps {}

export class CompleteStack extends cdk.Stack {
  /**
   * The echo Lambda function
   */
  public readonly echoFunction: lambda.DockerImageFunction

  constructor(scope: Construct, id: string, props?: CompleteStackProps) {
    super(scope, id, props)

    // Create a DockerImageFunction using a Bun-based image
    this.echoFunction = new lambda.DockerImageFunction(this, "EchoFunction", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "functions", "echo"),
      ),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      description: "Echo Lambda function - returns the input event",
    })

    // Output the function name and ARN
    new cdk.CfnOutput(this, "EchoFunctionName", {
      value: this.echoFunction.functionName,
      description: "Name of the echo function",
    })

    new cdk.CfnOutput(this, "EchoFunctionArn", {
      value: this.echoFunction.functionArn,
      description: "ARN of the echo function",
    })
  }
}
