/**
 * Complete example stack demonstrating DockerImageFunction and NodejsFunction with LiveLambdaAspect.
 *
 * This stack creates Lambda functions using:
 * - DockerImageFunction: Bun-based Docker images (echo, adder)
 * - NodejsFunction: TypeScript/JavaScript handlers (greeter, calculator)
 *
 * When CDK_LOCAL_LAMBDA=true is set, the aspect transforms them to use the bridge handler.
 */

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import { isInLocalMode } from "cdk-local-lambda"
import type { Construct } from "constructs"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface CompleteStackProps extends cdk.StackProps {}

export class CompleteStack extends cdk.Stack {
  /**
   * Docker echo Lambda function - returns the input event
   */
  public readonly dockerEcho: lambda.DockerImageFunction

  /**
   * Docker adder Lambda function - adds two numbers
   */
  public readonly dockerAdder: lambda.DockerImageFunction

  /**
   * TypeScript greeter Lambda function
   */
  public readonly tsGreeter: NodejsFunction

  /**
   * JavaScript calculator Lambda function
   */
  public readonly jsCalculator: NodejsFunction

  constructor(scope: Construct, id: string, props?: CompleteStackProps) {
    super(scope, id, props)

    // Docker function: echo (ARM64)
    this.dockerEcho = new lambda.DockerImageFunction(this, "DockerEcho", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "functions", "echo"),
      ),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Conditional timeout: longer in local mode for debugging
      timeout: isInLocalMode()
        ? cdk.Duration.minutes(5)
        : cdk.Duration.seconds(30),
      description: "Docker echo function - returns the input event",
    })

    // Docker function: adder (x86_64)
    this.dockerAdder = new lambda.DockerImageFunction(this, "DockerAdder", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "functions", "adder"),
      ),
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      // Conditional timeout: longer in local mode for debugging
      timeout: isInLocalMode()
        ? cdk.Duration.minutes(5)
        : cdk.Duration.seconds(30),
      description: "Docker adder function - adds two numbers",
      environment: {
        TEST: "12345",
      },
    })

    // TypeScript function: greeter (ARM64)
    this.tsGreeter = new NodejsFunction(this, "TsGreeter", {
      entry: path.join(__dirname, "..", "functions", "greeter", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Conditional timeout: longer in local mode for debugging
      timeout: isInLocalMode()
        ? cdk.Duration.minutes(5)
        : cdk.Duration.seconds(30),
      description: "TypeScript greeter function",
    })

    // JavaScript function: calculator (x86_64)
    this.jsCalculator = new NodejsFunction(this, "JsCalculator", {
      entry: path.join(
        __dirname,
        "..",
        "functions",
        "calculator",
        "handler.js",
      ),
      handler: "calculate",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      // Conditional timeout: longer in local mode for debugging
      timeout: isInLocalMode()
        ? cdk.Duration.minutes(5)
        : cdk.Duration.seconds(30),
      description: "JavaScript calculator function",
    })

    // Output the function names and ARNs
    new cdk.CfnOutput(this, "DockerEchoName", {
      value: this.dockerEcho.functionName,
      description: "Name of the Docker echo function",
    })

    new cdk.CfnOutput(this, "DockerEchoArn", {
      value: this.dockerEcho.functionArn,
      description: "ARN of the Docker echo function",
    })

    new cdk.CfnOutput(this, "DockerAdderName", {
      value: this.dockerAdder.functionName,
      description: "Name of the Docker adder function",
    })

    new cdk.CfnOutput(this, "DockerAdderArn", {
      value: this.dockerAdder.functionArn,
      description: "ARN of the Docker adder function",
    })

    new cdk.CfnOutput(this, "TsGreeterName", {
      value: this.tsGreeter.functionName,
      description: "Name of the TypeScript greeter function",
    })

    new cdk.CfnOutput(this, "TsGreeterArn", {
      value: this.tsGreeter.functionArn,
      description: "ARN of the TypeScript greeter function",
    })

    new cdk.CfnOutput(this, "JsCalculatorName", {
      value: this.jsCalculator.functionName,
      description: "Name of the JavaScript calculator function",
    })

    new cdk.CfnOutput(this, "JsCalculatorArn", {
      value: this.jsCalculator.functionArn,
      description: "ARN of the JavaScript calculator function",
    })
  }
}
