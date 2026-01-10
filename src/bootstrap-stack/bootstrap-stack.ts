import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"
import * as appsync from "aws-cdk-lib/aws-appsync"
import * as iam from "aws-cdk-lib/aws-iam"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as cr from "aws-cdk-lib/custom-resources"
import type { Construct } from "constructs"
import { SSM_BASE_PATH } from "../shared/types.js"

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Properties for the LiveLambdaBootstrapStack
 */
export interface CdkLocalLambdaBootstrapStackProps extends cdk.StackProps {
  /**
   * Optional name for the AppSync Events API
   * @default 'LiveLambdaEventsApi'
   */
  apiName?: string
}

/**
 * Bootstrap stack that creates the shared AppSync Events API infrastructure
 * for live lambda debugging. This stack should be deployed once per account/region.
 */
export class CdkLocalLambdaBootstrapStack extends cdk.Stack {
  /**
   * The AppSync Events API for WebSocket communication
   */
  public readonly api: appsync.CfnApi

  /**
   * The channel namespace for live debugging channels
   */
  public readonly channelNamespace: appsync.CfnChannelNamespace

  /**
   * The HTTP endpoint for publishing events
   */
  public readonly httpEndpoint: string

  /**
   * The WebSocket endpoint for real-time subscriptions
   */
  public readonly realtimeEndpoint: string

  /**
   * IAM role for publishing to the Events API
   */
  public readonly publishRole: iam.Role

  /**
   * S3 bucket for storing the bridge Lambda code
   */
  public readonly bridgeBucket: s3.Bucket

  constructor(
    scope: Construct,
    id: string,
    props?: CdkLocalLambdaBootstrapStackProps,
  ) {
    super(scope, id, props)

    const apiName = props?.apiName ?? "LiveLambdaEventsApi"

    // Create S3 bucket for bridge code
    this.bridgeBucket = new s3.Bucket(this, "BridgeBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    })

    // Create AppSync Events API with IAM authentication
    this.api = new appsync.CfnApi(this, "EventsApi", {
      name: apiName,
      eventConfig: {
        authProviders: [
          {
            authType: "AWS_IAM",
          },
        ],
        connectionAuthModes: [
          {
            authType: "AWS_IAM",
          },
        ],
        defaultPublishAuthModes: [
          {
            authType: "AWS_IAM",
          },
        ],
        defaultSubscribeAuthModes: [
          {
            authType: "AWS_IAM",
          },
        ],
      },
    })

    // Create channel namespace for live debugging
    // Channels will be: /live/{stackName}/{functionId}/in and /live/{stackName}/{functionId}/out
    this.channelNamespace = new appsync.CfnChannelNamespace(
      this,
      "LiveNamespace",
      {
        apiId: this.api.attrApiId,
        name: "live",
      },
    )

    // Store endpoints - using getAtt since attrDns is typed as IResolvable
    // Prepend protocols since AppSync only returns hostnames
    this.httpEndpoint = cdk.Fn.join("", [
      "https://",
      cdk.Token.asString(this.api.getAtt("Dns.Http")),
    ])
    this.realtimeEndpoint = cdk.Fn.join("", [
      "wss://",
      cdk.Token.asString(this.api.getAtt("Dns.Realtime")),
    ])

    // Create IAM role for Lambda functions to publish/subscribe
    this.publishRole = new iam.Role(this, "PublishRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Role for Lambda functions to publish/subscribe to Live Lambda Events API",
    })

    // Grant permissions to publish and subscribe to the Events API
    this.publishRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "appsync:EventConnect",
          "appsync:EventPublish",
          "appsync:EventSubscribe",
        ],
        resources: [`${this.api.attrApiArn}/*`, this.api.attrApiArn],
      }),
    )

    // Create SSM parameters for the endpoints
    // These are used by the live-lambda-aspect to configure Lambda functions
    // Use the CDK bootstrap qualifier for proper scoping
    const bootstrapQualifier =
      this.node.tryGetContext("@aws-cdk/core:bootstrapQualifier") || "hnb659fds"
    const ssmBasePath = `${SSM_BASE_PATH}/${bootstrapQualifier}`

    new ssm.StringParameter(this, "HttpEndpointParam", {
      parameterName: `${ssmBasePath}/http-endpoint`,
      stringValue: this.httpEndpoint,
      description: "AppSync Events HTTP endpoint for Live Lambda",
    })

    new ssm.StringParameter(this, "RealtimeEndpointParam", {
      parameterName: `${ssmBasePath}/realtime-endpoint`,
      stringValue: this.realtimeEndpoint,
      description: "AppSync Events WebSocket endpoint for Live Lambda",
    })

    new ssm.StringParameter(this, "ApiArnParam", {
      parameterName: `${ssmBasePath}/api-arn`,
      stringValue: this.api.attrApiArn,
      description: "AppSync Events API ARN for Live Lambda",
    })

    new ssm.StringParameter(this, "ApiIdParam", {
      parameterName: `${ssmBasePath}/api-id`,
      stringValue: this.api.attrApiId,
      description: "AppSync Events API ID for Live Lambda",
    })

    // Build bridge handler and upload to S3
    const bridgeS3Location = this.buildAndUploadBridge()

    // Store bridge S3 location in SSM
    new ssm.StringParameter(this, "BridgeBucketParam", {
      parameterName: `${ssmBasePath}/bridge-bucket`,
      stringValue: bridgeS3Location.bucketName,
      description: "S3 bucket containing Live Lambda bridge code",
    })

    new ssm.StringParameter(this, "BridgeKeyParam", {
      parameterName: `${ssmBasePath}/bridge-key`,
      stringValue: bridgeS3Location.s3Key,
      description: "S3 key for Live Lambda bridge code",
    })

    // Output the endpoints (for CLI and debugging)
    new cdk.CfnOutput(this, "HttpEndpoint", {
      value: this.httpEndpoint,
      description: "AppSync Events HTTP endpoint",
    })

    new cdk.CfnOutput(this, "RealtimeEndpoint", {
      value: this.realtimeEndpoint,
      description: "AppSync Events WebSocket endpoint",
    })

    new cdk.CfnOutput(this, "ApiId", {
      value: this.api.attrApiId,
      description: "AppSync Events API ID",
    })

    new cdk.CfnOutput(this, "ApiArn", {
      value: this.api.attrApiArn,
      description: "AppSync Events API ARN",
    })

    new cdk.CfnOutput(this, "PublishRoleArn", {
      value: this.publishRole.roleArn,
      description: "IAM Role ARN for publishing to Events API",
    })
  }

  /**
   * Grant a Lambda function permission to publish and subscribe to the Events API
   */
  public grantPublishSubscribe(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: [
        "appsync:EventConnect",
        "appsync:EventPublish",
        "appsync:EventSubscribe",
      ],
      resourceArns: [`${this.api.attrApiArn}/*`, this.api.attrApiArn],
    })
  }

  /**
   * Build the bridge handler and upload to S3 using a custom resource.
   * The bridge code has AppSync endpoints baked in at deploy time.
   */
  private buildAndUploadBridge(): { bucketName: string; s3Key: string } {
    // Build the bridge source code at synth time (with placeholders)
    const bridgePath = path.join(__dirname, "..", "functions", "bridge")
    const outputPath = path.join(__dirname, "..", "out-tsc", "bridge-bundle.js")

    // Bundle the bridge handler
    try {
      execSync(
        `bun build ${bridgePath}/handler.ts --outfile=${outputPath} --target=node --format=cjs --bundle --external=@aws-sdk/*`,
        { stdio: "pipe" },
      )
    } catch (err) {
      console.error("Failed to bundle bridge handler:", err)
      throw err
    }

    // Read the bundled code
    const bridgeSource = fs.readFileSync(outputPath, "utf-8")

    // Create the bridge builder Lambda that will replace placeholders and upload
    const bridgeBuilderPath = path.join(
      __dirname,
      "..",
      "functions",
      "bridge-builder",
    )
    const bridgeBuilder = new lambda.Function(this, "BridgeBuilder", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bridgeBuilderPath, {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "npm install --prefix /tmp esbuild",
              "/tmp/node_modules/.bin/esbuild handler.ts --bundle --platform=node --target=node22 --format=cjs --outfile=/asset-output/index.js --external:@aws-sdk/*",
            ].join(" && "),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  `bun build ${bridgeBuilderPath}/handler.ts --outfile=${outputDir}/index.js --target=node --format=cjs --bundle --external=@aws-sdk/*`,
                  { stdio: "pipe" },
                )
                return true
              } catch {
                return false
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
    })

    // Grant the builder Lambda permission to write to the bridge bucket
    this.bridgeBucket.grantWrite(bridgeBuilder)

    // Create custom resource provider
    const provider = new cr.Provider(this, "BridgeBuilderProvider", {
      onEventHandler: bridgeBuilder,
      logRetention: logs.RetentionDays.ONE_WEEK,
    })

    // Create custom resource that builds and uploads the bridge
    const bridgeResource = new cdk.CustomResource(this, "BridgeResource", {
      serviceToken: provider.serviceToken,
      properties: {
        HttpEndpoint: this.httpEndpoint,
        RealtimeEndpoint: this.realtimeEndpoint,
        BucketName: this.bridgeBucket.bucketName,
        BridgeSource: Buffer.from(bridgeSource).toString("base64"),
        // Force update when source changes
        SourceHash: cdk.Fn.base64(bridgeSource.substring(0, 100)),
      },
    })

    // Ensure the bridge is built after the bucket exists
    bridgeResource.node.addDependency(this.bridgeBucket)

    return {
      bucketName: bridgeResource.getAttString("BucketName"),
      s3Key: bridgeResource.getAttString("S3Key"),
    }
  }
}
