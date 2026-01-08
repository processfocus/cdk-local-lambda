# Goal

Deploy an almost unmodified CDK stack, but run lambdas on local
machine instead of remote.

# How

We deploy a CDK stack and replace all lambdas with a bridge
adapter. The bridge adapter opens a websocket connection to AppSync
Events, and sends the messages it receives.

The local daemon also has a websocket open to AppSync Events. When it
receives a message, it runs the corresponding lambda locally. It send
the response back the response via websockets.

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
AppSync events has channel name length limits.

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

Details on how this works.

1. How do we deal with large messages
2. What is the message structure.

# Daemon

The daemon opens up one single websocket subscription to AppSync. It
uses SSM parameters to know which to access.

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

When the daemon receives a message on an in channel, it starts a
lambda runtime emulator. This process exposes a lambda runtime
interface to the lambda inside it.

For example for a Docker runtime, the Docker runtime would query this
runtime emulator, and it knows now better than that it is running in a
true lambda runtime, as all normal endpoints are available.

Same for Typescript: the runtime emulator spins up a node process that
loads the handler, then keeps querying the runtime for messages just
like the AWS node runtime does, and then hands them off one by one to
the typescript handler it has loaded, and returns the responses.

The local lambda runtime emulator should use the Effect TS HttpServer and
pick an ephemeral port.

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
