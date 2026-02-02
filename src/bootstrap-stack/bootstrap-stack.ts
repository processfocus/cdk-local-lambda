import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as cdk from "aws-cdk-lib"
import * as appsync from "aws-cdk-lib/aws-appsync"
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets"
import * as iam from "aws-cdk-lib/aws-iam"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as s3Assets from "aws-cdk-lib/aws-s3-assets"
import * as ssm from "aws-cdk-lib/aws-ssm"
import type { Construct } from "constructs"
import { BOOTSTRAP_VERSION, SSM_BASE_PATH } from "../shared/types.js"

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

    // Build and store Docker bridge images for DockerImageFunction support
    const dockerBridgeImages = this.buildDockerBridgeImages()

    new ssm.StringParameter(this, "BridgeImageArm64Param", {
      parameterName: `${ssmBasePath}/bridge-image-arm64`,
      stringValue: dockerBridgeImages.arm64ImageUri,
      description: "ECR image URI for ARM64 bridge Docker image",
    })

    new ssm.StringParameter(this, "BridgeImageX86Param", {
      parameterName: `${ssmBasePath}/bridge-image-x86_64`,
      stringValue: dockerBridgeImages.x86ImageUri,
      description: "ECR image URI for x86_64 bridge Docker image",
    })

    // Store the bootstrap version for compatibility checking
    new ssm.StringParameter(this, "VersionParam", {
      parameterName: `${ssmBasePath}/version`,
      stringValue: BOOTSTRAP_VERSION,
      description: "Bootstrap stack version for Live Lambda",
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
   * Upload the pre-bundled bridge handler code as an S3 asset.
   * The bridge handler replaces the lambda code, and forwards messages
   * to a local daemon, and receives and returns the response.
   *
   * The bridge is pre-bundled at package build time (see post-compile task
   * in .projenrc.ts), so users don't need to compile it at CDK synth time.
   */
  private buildAndUploadBridge(): {
    bucketName: string
    s3Key: string
  } {
    // Points to functions/bridge relative to this file (works from both src/ and lib/)
    const bridgePath = path.join(__dirname, "..", "functions", "bridge")

    const bridgeAsset = new s3Assets.Asset(this, "BridgeAsset", {
      path: bridgePath,
    })

    return {
      bucketName: bridgeAsset.s3BucketName,
      s3Key: bridgeAsset.s3ObjectKey,
    }
  }

  /**
   * Build Docker bridge images for ARM64 and x86_64 architectures.
   * Uses CDK Docker image assets to build and push to ECR.
   *
   * The runtime and Docker assets are pre-bundled at package build time
   * (see post-compile tasks in .projenrc.ts), so users don't need bun
   * or any build tools at CDK synth time.
   */
  private buildDockerBridgeImages(): {
    arm64ImageUri: string
    x86ImageUri: string
  } {
    // Points to functions/bridge-docker relative to this file (works from both src/ and lib/)
    // Contains pre-bundled runtime.js, Dockerfiles, and bootstrap.sh
    const bridgeDockerPath = path.join(
      __dirname,
      "..",
      "functions",
      "bridge-docker",
    )

    // Build ARM64 image using CDK Docker image asset
    const arm64Image = new ecrAssets.DockerImageAsset(
      this,
      "BridgeImageArm64",
      {
        directory: bridgeDockerPath,
        file: "Dockerfile.arm64",
        platform: ecrAssets.Platform.LINUX_ARM64,
      },
    )

    // Build x86_64 image using CDK Docker image asset
    const x86Image = new ecrAssets.DockerImageAsset(this, "BridgeImageX86", {
      directory: bridgeDockerPath,
      file: "Dockerfile.x86_64",
      platform: ecrAssets.Platform.LINUX_AMD64,
    })

    // Output the image URIs
    new cdk.CfnOutput(this, "BridgeImageArm64Uri", {
      value: arm64Image.imageUri,
      description: "ECR URI for ARM64 bridge Docker image",
    })

    new cdk.CfnOutput(this, "BridgeImageX86Uri", {
      value: x86Image.imageUri,
      description: "ECR URI for x86_64 bridge Docker image",
    })

    return {
      arm64ImageUri: arm64Image.imageUri,
      x86ImageUri: x86Image.imageUri,
    }
  }
}
