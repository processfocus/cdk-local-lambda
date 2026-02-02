# cdk-local-lambda

Run Lambda functions from your CDK stack locally. Edit your code and see changes immediately—no redeployment required.

## Supported Runtimes

| Runtime | Status |
|---------|--------|
| TypeScript / JavaScript | Supported |
| Docker | Supported |
| Python | Not yet supported |
| Java | Not yet supported |

## Comparison with SST v2

This project provides similar live Lambda development capabilities to [SST v2's Live Lambda Dev](https://v2.sst.dev/live-lambda-development), but with a key difference: **cdk-local-lambda works with vanilla CDK**.

SST v2 requires adopting SST's stack conventions and constructs. With cdk-local-lambda, you keep your existing CDK code as-is—just add the bootstrap import and apply the aspect.

## Installation

```bash
npm install cdk-local-lambda
```

## Quick Start

Setting up local Lambda development requires three steps:

1. Load the bootstrap module
2. Apply the LiveLambda aspect
3. Start the local daemon

### 1. Load the bootstrap module

The bootstrap module patches CDK internals to enable local execution. The loading method depends on your runtime.

#### tsx / ts-node

In your CDK app entry point (e.g., `bin/app.ts`), import the bootstrap module before any other imports:

```typescript
import "cdk-local-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
```

#### Bun

Bun requires preloading the bootstrap module because it snapshots CommonJS exports during static ESM import linking. A regular import statement runs too late.

Add the `--preload` flag to your `cdk.json`:

```json
{
  "app": "bun --preload cdk-local-lambda/bootstrap bin/app.ts"
}
```

### 2. Apply the LiveLambda aspect

In your CDK app entry point (e.g., `bin/app.ts`), apply the aspect after defining your stacks:

```typescript
import "cdk-local-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "cdk-local-lambda"

const app = new cdk.App()
const stack = new MyStack(app, "MyStack")

applyLiveLambdaAspect(app)

app.synth()
```

### 3. Start the local daemon

The daemon deploys your stack with live mode enabled and runs Lambda functions locally:

```bash
npx cll local
```

For multiple stacks, specify which one to use:

```bash
npx cll local --stacks MyStack
```

When ready, you'll see:

```
[15:09:16.979] INFO: [Local] Starting local Lambda development...
[15:09:19.747] INFO: [CDK] Deploying...
[15:09:19.757] INFO: [Local] Press Ctrl+C to stop
[15:09:25.870] INFO: [CDK] Deploy complete
[15:09:26.878] INFO: [Local] Discovering functions...
[15:09:30.837] INFO: [Local] Functions: JsCalculatorBD1C3822 (node), DockerAdder757B287D (docker), TsGreeter58FA51CD (node)
[15:09:30.841] INFO: [Local] Ready for invocations
```

Now invoke your Lambda normally via the AWS CLI or SDK:

```bash
aws lambda invoke --function-name MyStack-TsGreeter58FA51CD-EiQlVgIoZhz4 \
  --payload '{"name": "World"}' \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout
```

```json
{"message":"Hello, World!","timestamp":"2026-02-02T02:10:11.920Z"}
```

The local console shows each invocation with any `console.log` output from your function:

```
[1] ┌── MyStack-TsGreeter58FA51CD-EiQlVgIoZhz4 ──
[1] [Greeter] Received greeting request for: World
[1] └── ✓ Done (892ms) ──
```

### Manual bootstrap (optional)

To deploy the bootstrap stack separately:

```bash
npx cll bootstrap --profile my-profile --region us-west-2
```

## Options

### Conditional Configuration

Use `isInLocalMode()` to conditionally configure your constructs when running locally:

```typescript
import { isInLocalMode } from "cdk-local-lambda"

new lambda.Function(this, "MyFunction", {
  // Longer timeout for local debugging
  timeout: isInLocalMode()
    ? cdk.Duration.minutes(5)
    : cdk.Duration.seconds(30),
  // ... other props
})
```

### Credentials

Run daemon with a specific credential and region:

```bash
npx cll local --stacks MyStack --profile my-profile --region us-west-2
```

## Troubleshooting

### "No functions found with live-lambda tags yet"

This error appears when the bootstrap module or aspect is not configured correctly.

**Checklist:**

- Verify that `cdk-local-lambda/bootstrap` is loaded (use `--preload` for Bun)
- Confirm that `applyLiveLambdaAspect(app)` is called in your app entry point
- Ensure the aspect is applied after all stacks are defined
