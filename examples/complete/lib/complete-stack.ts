/**
 * Complete example stack demonstrating DockerImageFunction and NodejsFunction with LiveLambdaAspect.
 *
 * This stack creates Lambda functions using:
 * - DockerImageFunction: Bun-based Docker images (echo, adder)
 * - NodejsFunction: TypeScript/JavaScript handlers (greeter, calculator)
 *
 * When CDK_LIVE=true is set, the aspect transforms them to use the bridge handler.
 */

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import type { Construct } from "constructs"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface CompleteStackProps extends cdk.StackProps {}

export class CompleteStack extends cdk.Stack {
  /**
   * The echo Lambda function (Docker)
   */
  public readonly echoFunction: lambda.DockerImageFunction

  /**
   * The adder Lambda function (Docker)
   */
  public readonly adderFunction: lambda.DockerImageFunction

  /**
   * The greeter Lambda function (Node.js TypeScript)
   */
  public readonly greeterFunction: NodejsFunction

  /**
   * The calculator Lambda function (Node.js JavaScript)
   */
  public readonly calculatorFunction: NodejsFunction

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

    // Create an adder DockerImageFunction (x64 architecture)
    this.adderFunction = new lambda.DockerImageFunction(this, "AdderFunction", {
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "functions", "adder"),
      ),
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      description: "Adder Lambda function - adds two numbers",
    })

    // Create a NodejsFunction with TypeScript handler
    this.greeterFunction = new NodejsFunction(this, "GreeterFunction", {
      entry: path.join(__dirname, "..", "functions", "greeter", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      description: "Greeter Lambda function - TypeScript handler",
    })

    // Create a NodejsFunction with JavaScript handler
    this.calculatorFunction = new NodejsFunction(this, "CalculatorFunction", {
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
      timeout: cdk.Duration.seconds(30),
      description: "Calculator Lambda function - JavaScript handler",
    })

    // Output the function names and ARNs
    new cdk.CfnOutput(this, "EchoFunctionName", {
      value: this.echoFunction.functionName,
      description: "Name of the echo function",
    })

    new cdk.CfnOutput(this, "EchoFunctionArn", {
      value: this.echoFunction.functionArn,
      description: "ARN of the echo function",
    })

    new cdk.CfnOutput(this, "AdderFunctionName", {
      value: this.adderFunction.functionName,
      description: "Name of the adder function",
    })

    new cdk.CfnOutput(this, "AdderFunctionArn", {
      value: this.adderFunction.functionArn,
      description: "ARN of the adder function",
    })

    new cdk.CfnOutput(this, "GreeterFunctionName", {
      value: this.greeterFunction.functionName,
      description: "Name of the greeter function",
    })

    new cdk.CfnOutput(this, "GreeterFunctionArn", {
      value: this.greeterFunction.functionArn,
      description: "ARN of the greeter function",
    })

    new cdk.CfnOutput(this, "CalculatorFunctionName", {
      value: this.calculatorFunction.functionName,
      description: "Name of the calculator function",
    })

    new cdk.CfnOutput(this, "CalculatorFunctionArn", {
      value: this.calculatorFunction.functionArn,
      description: "ARN of the calculator function",
    })
  }
}
