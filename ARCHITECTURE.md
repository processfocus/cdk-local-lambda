# Goal

Deploy an almost unmodified CDK stack, but run lambdas on local
machine instead of remote.

# How

We deploy a CDK stack and replace all lambdas with a bridge
adapter. The bridge adapter opens a websocket connection to AppSync
Events, and sends the requests it receives to AppSync Events.

The local daemon also has a websocket open to AppSync Events. When it
receives a message, it runs the corresponding lambda locally. It sends
the response back via websockets.

The bridge lambda adapter has a web socket listener as well, and when
it receives a response, returns it to the caller.

Flow:

1. Cold start: the bridge subscribes to the response channel
    `/live/{hash}/out`. It wait for subscription to be confirmed.

2. After subscription is confirmed, publish the invoke message to the
   input channel `/live/{hash}/in`. If the invoke is a cold start, it
   includes all environment variables. Subsequent responses will omit them.
   The message includes the request id and the function name.

3. Block waiting for a response message with the matching request ID.

4. Daemon invokes the lambda locally, waits for the response, and then
   publishes the response to the out channel  `/live/{hash}/out`.

5. The bridge's WebSocket subscription receives the response message,
   checks if the id matches the expected request ID, and then returns
   this as the result.

The hash in these channelsis the SHA256 hash of the function name,
truncated to 16 hex characters. The reason to use a hash is that
AppSync events has a limit of 50 characters per segment of a channel
name.

Algorithm:

```ts
function channelName(functionName: string, direction: "in" | "out"): string {
  const crypto = require("node:crypto")
  const hash = crypto
    .createHash("sha256")
    .update(functionName)
    .digest("hex")
    .substring(0, 16)  // First 16 hex chars
  return `/live/${hash}/${direction}`
}
```

# Usage

Run with:

```
bun src/cli/index.ts live CdkLiveLambdaStack
```

This deploys the given stack in "live" mode.

# Requirements

1. Minimal change to CDK stack.
2. Lambda to be run locally should require minimal changes in
   CloudFormation deploy. In particular it cannot be
   replaced. Changing platform type for example canot be done.
3. So we swap out the real lambda by a bridge lambda, and we have three versions:
   a. ZIP version
   b. arm64 docker.
   c. X64 docker
4. No environment variables can be replaced.
5. Should not rely on control plane API for operation.
6. We simply swap out the function implementation. The bridge simply replaces the existing implementation without further changes.
7. We can swap in the bridge adapter, without any changes to the bridge adapter.
8. This implies that the function when invoked, doesn't know about its
   stack (you could use tagging, but that would mean you need to use
   the tagging API to find out). All it knows is its function name.
9. It will use SSM parameters to find the AppSync Event bridge to use for websockets.
10. Those additional SSM parameters will be supplied when deployed live.

# Bootstrap stack

We use a single bootstrap stack per AWS region and account. This stack
contains the AWS AppSync Event bridge setup, and the bridge adapters.

The name of the stack is `CdkLocalLambdaBootstrapStack`.

# Message passing

## Message types

- **invoke**: Bridge → Daemon. Carries the Lambda event and context.
- **response**: Daemon → Bridge. Contains the success result or error.
- **ping/pong**: Keepalive messages for WebSocket connection health.

## Base message structure

All messages share these fields:

```ts
interface BaseMessage {
  type: "invoke" | "response" | "error" | "ping" | "pong"
  id: string           // Request ID for correlation
  functionId: string   // Lambda function identifier
  timestamp: number    // Unix epoch ms
}
```

## Request ID

The message `id` field uses the Lambda's `context.awsRequestId`. This provides:

- Unique ID per invocation (no generation needed)
- Direct correlation with CloudWatch logs
- Traceability across the bridge/daemon boundary

Example: `a1b2c3d4-5678-90ab-cdef-1234567890ab`

## InvokeMessage

Sent from bridge lambda to daemon when a Lambda is invoked:

```ts
interface InvokeMessage extends BaseMessage {
  type: "invoke"
  event: unknown                     // Lambda event payload
  context: SerializableLambdaContext
  deadline: number                   // Timeout deadline (epoch ms)
  env?: Record<string, string>       // Only present on cold start
}

interface SerializableLambdaContext {
  awsRequestId: string
  functionName: string
  functionVersion: string
  invokedFunctionArn: string
  memoryLimitInMB: string
  logGroupName: string
  logStreamName: string
}
```

## ResponseMessage

Sent from daemon to bridge lambda after handler execution:

```ts
interface ResponseMessage extends BaseMessage {
  type: "response"
  body?: unknown      // Success response (mutually exclusive with error)
  error?: {           // Error details (mutually exclusive with body)
    name: string
    message: string
    stack?: string
  }
}
```

## Environment variables

Environment variables are only sent on cold start (when `env` is present).
The daemon caches env vars per function for subsequent invokes.

The bridge filters out Lambda internals that shouldn't be forwarded:

- Runtime internals: `_HANDLER`, `LAMBDA_TASK_ROOT`, `AWS_LAMBDA_RUNTIME_API`,
  `AWS_LAMBDA_INITIALIZATION_TYPE`, `_LAMBDA_CONSOLE_SOCKET`,
  `_LAMBDA_CONTROL_SOCKET`, `_LAMBDA_LOG_FD`
- System vars: `PATH`, `PWD`, `HOME`, `USER`, `SHELL`, `TERM`,
  `LD_LIBRARY_PATH`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`
- X-Ray: `AWS_XRAY_DAEMON_ADDRESS`, `_AWS_XRAY_DAEMON_ADDRESS`

## Large message chunking

AppSync Events has a 64KB message limit. When an InvokeMessage or
ResponseMessage exceeds this limit, it is wrapped in ChunkedMessage packets.

The receiver distinguishes message types by checking for the `index` field:
- If `index` is present → ChunkedMessage (reassemble first)
- If `index` is absent → regular InvokeMessage or ResponseMessage

```ts
interface ChunkedMessage {
  id: string      // Same request ID (awsRequestId) for all chunks
  index: number   // Chunk index (0-based)
  count: number   // Total number of chunks
  data: string    // Base64 encoded chunk data
  final: boolean  // True for last chunk
}
```

Chunking algorithm:

1. Serialize InvokeMessage or ResponseMessage to JSON, base64 encode.
2. If size ≤ 64KB, send the message directly (not chunked).
3. If size > 64KB, split into chunks of ~63KB (200 byte overhead for wrapper).
4. Send each ChunkedMessage as separate AppSync message.
5. Receiver reassembles chunks by id + index, validates with count + final.
6. After reassembly, base64 decode and JSON parse to get original message.
7. 30-second timeout for incomplete chunked messages.

# Bridge and Daemon API

## Bridge Lambda

The bridge lambda needs to perform these operations:

1. **Subscribe** to `/live/{hash}/out` (response channel)
2. **Publish** InvokeMessage to `/live/{hash}/in`
3. **Wait** for ResponseMessage on the subscription
4. **Unsubscribe** and close connection

The bridge must subscribe before publishing to avoid missing the response.

## Daemon

The daemon needs to perform these operations:

1. **Subscribe** to `/live/{hash}/in` for each live function
2. **Receive** InvokeMessages, reassemble chunks if needed
3. **Execute** the local handler
4. **Publish** ResponseMessage to `/live/{hash}/out`

The daemon maintains a single long-lived WebSocket connection and
subscribes to multiple channels (one per function).

# Daemon

The daemon opens up one single websocket subscription to AppSync. It
uses SSM parameters to know which AppSync Events instance to access.

The daemon subscribes to all lambdas which are live in the
stack. Before deploying the stack, it is unknown what function name
CloudFormation will assign, so this is a three step process:

1. Deploy the stack, tag every function with the location of its local
   handler: `cdk-local-lambda:handler = <local-handler-path>`.
   This tag is present whenever the aspect is added to the stack,
   regardless if it is running live or not.
2. At startup, the daemon queries the functions with the local lambda
   tag: Calls ListFunctions + ListTags APIs to find tagged functions.
   It can then build a map of functionName -> localHandler for routing
   invocations to the correct local code
3. The daemon subscribes to all `/live/{hash}/in` channels.
4. The daemon updates it lists of tags when the cdk stack is
   redeployed (it runs in watch mode).

When the daemon receives a message on the "in" channel, it starts a
new fiber exposing a new Effect HttpServer on an ephemoral port. This
fibre emulates a lambda environment. The fibre then starts a new
runtime process to run the code.

For example for a Docker runtime, the Docker runtime would query the
exposed runtime API for messages. It has no way of distinguishing its
running locally or in an emulated environment. All normal endpoints it
expects are available.

Same for Typescript: the runtime emulator spins up a node process that
loads the handler, then keeps querying the runtime API for messages
just like the AWS node runtime does, and then hands them off one by
one to the typescript handler it has loaded, and returns the
responses.

# CDK watch mode

The daemon also runs CDK in watch mode, with hot reload enabled.


# Stack modifications

```ts
import { applyLiveLambdaAspect } from "../lib/live-lambda-aspect.js"

// Apply live lambda aspect when CDK_LIVE=true
applyLiveLambdaAspect(exampleStack)
```

```ts
import "../lib/hook-bootstrap.js"
```
