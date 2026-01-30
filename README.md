# cdk-local-lambda

Run Lambda functions from your CDK stack locally. Edit your code and see changes immediately—no redeployment required.

## Supported Runtimes

| Runtime | Status |
|---------|--------|
| TypeScript / JavaScript | Supported |
| Docker | Supported |
| Python | Not yet supported |
| Java | Not yet supported |

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

To specify AWS credentials:

```bash
npx cll local --stacks MyStack --profile my-profile --region us-west-2
```

### Manual bootstrap (optional)

To deploy the bootstrap stack separately:

```bash
npx cll bootstrap --profile my-profile --region us-west-2
```

## Troubleshooting

### "No functions found with live-lambda tags yet"

This error appears when the bootstrap module or aspect is not configured correctly.

**Checklist:**

- Verify that `cdk-local-lambda/bootstrap` is loaded (use `--preload` for Bun)
- Confirm that `applyLiveLambdaAspect(app)` is called in your app entry point
- Ensure the aspect is applied after all stacks are defined
