/**
 * Custom resource handler that builds and uploads the bridge Lambda code.
 *
 * This handler:
 * 1. Receives the bridge source code (base64 encoded) and AppSync endpoints
 * 2. Replaces endpoint placeholders with actual values
 * 3. Uploads the final code to S3
 * 4. Returns the S3 location for Lambda functions to use
 */

import * as crypto from "node:crypto"
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from "aws-lambda"

const s3 = new S3Client({})

interface ResourceProperties {
  HttpEndpoint: string
  RealtimeEndpoint: string
  BucketName: string
  BridgeSource: string // Base64 encoded
  SourceHash?: string
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> {
  console.log("Received event:", JSON.stringify(event, null, 2))

  const props = event.ResourceProperties as unknown as ResourceProperties
  const { HttpEndpoint, RealtimeEndpoint, BucketName, BridgeSource } = props

  // Generate a unique key for this version
  const sourceHash = crypto
    .createHash("md5")
    .update(BridgeSource)
    .digest("hex")
    .substring(0, 8)
  const s3Key = `bridge/handler-${sourceHash}.js`

  try {
    if (event.RequestType === "Delete") {
      // Clean up: delete the S3 object
      await s3.send(
        new DeleteObjectCommand({
          Bucket: BucketName,
          Key: s3Key,
        }),
      )

      return {
        Status: "SUCCESS",
        PhysicalResourceId: s3Key,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: {},
      }
    }

    // Create or Update
    // Decode the base64 source
    const bridgeCode = Buffer.from(BridgeSource, "base64").toString("utf-8")

    // Replace placeholders with actual endpoints
    const finalCode = bridgeCode
      .replace(/__APPSYNC_HTTP_ENDPOINT__/g, HttpEndpoint)
      .replace(/__APPSYNC_REALTIME_ENDPOINT__/g, RealtimeEndpoint)

    // Upload to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: BucketName,
        Key: s3Key,
        Body: finalCode,
        ContentType: "application/javascript",
      }),
    )

    console.log(`Uploaded bridge code to s3://${BucketName}/${s3Key}`)

    return {
      Status: "SUCCESS",
      PhysicalResourceId: s3Key,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        BucketName,
        S3Key: s3Key,
      },
    }
  } catch (error) {
    console.error("Error:", error)

    return {
      Status: "FAILED",
      Reason: error instanceof Error ? error.message : "Unknown error",
      PhysicalResourceId: s3Key,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {},
    }
  }
}
