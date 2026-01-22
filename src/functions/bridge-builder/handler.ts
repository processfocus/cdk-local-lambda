/**
 * Custom resource handler that builds and uploads the bridge Lambda code.
 *
 * This handler:
 * 1. Receives the bridge source code (base64 encoded) and AppSync endpoints
 * 2. Replaces endpoint placeholders with actual values
 * 3. Creates a zip file with the code
 * 4. Uploads the zip to S3
 * 5. Returns the S3 location for Lambda functions to use
 */

import * as crypto from "node:crypto"
import * as zlib from "node:zlib"
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

/**
 * Create a minimal zip file containing a single file.
 * This is a simple implementation that creates a valid zip without external dependencies.
 */
function createZip(filename: string, content: string): Buffer {
  const contentBuffer = Buffer.from(content, "utf-8")

  // Compress the content using deflate
  const compressed = zlib.deflateRawSync(contentBuffer)

  const crc32 = crc32buf(contentBuffer)
  const now = new Date()

  // DOS time and date
  const dosTime =
    ((now.getHours() << 11) |
      (now.getMinutes() << 5) |
      Math.floor(now.getSeconds() / 2)) &
    0xffff
  const dosDate =
    (((now.getFullYear() - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate()) &
    0xffff

  const filenameBuffer = Buffer.from(filename, "utf-8")

  // Local file header
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
  localHeader.writeUInt16LE(20, 4) // Version needed to extract (2.0)
  localHeader.writeUInt16LE(0, 6) // General purpose bit flag
  localHeader.writeUInt16LE(8, 8) // Compression method (deflate)
  localHeader.writeUInt16LE(dosTime, 10) // Last mod file time
  localHeader.writeUInt16LE(dosDate, 12) // Last mod file date
  localHeader.writeUInt32LE(crc32, 14) // CRC-32
  localHeader.writeUInt32LE(compressed.length, 18) // Compressed size
  localHeader.writeUInt32LE(contentBuffer.length, 22) // Uncompressed size
  localHeader.writeUInt16LE(filenameBuffer.length, 26) // Filename length
  localHeader.writeUInt16LE(0, 28) // Extra field length

  // Central directory header
  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0) // Central directory signature
  centralHeader.writeUInt16LE(20, 4) // Version made by
  centralHeader.writeUInt16LE(20, 6) // Version needed to extract
  centralHeader.writeUInt16LE(0, 8) // General purpose bit flag
  centralHeader.writeUInt16LE(8, 10) // Compression method
  centralHeader.writeUInt16LE(dosTime, 12) // Last mod file time
  centralHeader.writeUInt16LE(dosDate, 14) // Last mod file date
  centralHeader.writeUInt32LE(crc32, 16) // CRC-32
  centralHeader.writeUInt32LE(compressed.length, 20) // Compressed size
  centralHeader.writeUInt32LE(contentBuffer.length, 24) // Uncompressed size
  centralHeader.writeUInt16LE(filenameBuffer.length, 28) // Filename length
  centralHeader.writeUInt16LE(0, 30) // Extra field length
  centralHeader.writeUInt16LE(0, 32) // File comment length
  centralHeader.writeUInt16LE(0, 34) // Disk number start
  centralHeader.writeUInt16LE(0, 36) // Internal file attributes
  centralHeader.writeUInt32LE(0, 38) // External file attributes
  centralHeader.writeUInt32LE(0, 42) // Relative offset of local header

  // End of central directory
  const localFileDataSize =
    localHeader.length + filenameBuffer.length + compressed.length
  const centralDirSize = centralHeader.length + filenameBuffer.length

  const endOfCentralDir = Buffer.alloc(22)
  endOfCentralDir.writeUInt32LE(0x06054b50, 0) // End of central dir signature
  endOfCentralDir.writeUInt16LE(0, 4) // Disk number
  endOfCentralDir.writeUInt16LE(0, 6) // Disk number with central dir
  endOfCentralDir.writeUInt16LE(1, 8) // Number of entries on this disk
  endOfCentralDir.writeUInt16LE(1, 10) // Total number of entries
  endOfCentralDir.writeUInt32LE(centralDirSize, 12) // Size of central directory
  endOfCentralDir.writeUInt32LE(localFileDataSize, 16) // Offset of central directory
  endOfCentralDir.writeUInt16LE(0, 20) // Comment length

  return Buffer.concat([
    localHeader,
    filenameBuffer,
    compressed,
    centralHeader,
    filenameBuffer,
    endOfCentralDir,
  ])
}

/**
 * Calculate CRC-32 of a buffer.
 */
function crc32buf(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

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
  const s3Key = `bridge/handler-${sourceHash}.zip`

  try {
    if (event.RequestType === "Delete") {
      // Clean up: delete the S3 object
      // Use the physical resource ID from the event, not the computed s3Key
      // This handles the case where the key format changed between versions
      const keyToDelete = event.PhysicalResourceId || s3Key
      console.log(`Deleting S3 object: s3://${BucketName}/${keyToDelete}`)

      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: BucketName,
            Key: keyToDelete,
          }),
        )
      } catch (deleteError) {
        // Ignore delete errors - the object might not exist
        console.log(`Note: Could not delete ${keyToDelete}: ${deleteError}`)
      }

      return {
        Status: "SUCCESS",
        PhysicalResourceId: event.PhysicalResourceId || s3Key,
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

    // Create a zip file containing the handler code
    // Lambda expects the handler file to be named 'index.js' when handler is 'index.handler'
    const zipBuffer = createZip("index.js", finalCode)

    // Upload to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: BucketName,
        Key: s3Key,
        Body: zipBuffer,
        ContentType: "application/zip",
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
