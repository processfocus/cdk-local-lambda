# Run lambdas in CDK stack locally

Run typescript and docker lambdas in a standard CDK stack
locally. This improves the DX as you can edit lambdas and see changes
and fixes immediately.

Only two minor changes to your CDK stack are needed.

## Installation

```bash
npm install cdk-local-lambda
```

## Usage

### 1. Add the bootstrap to your CDK app

Unfortunately CDK hides lambda internals which we need to know. Until
CDK accepts our patch to improve this, you need to live patch
CDK. This depends on how you run your CDK app.

#### tsx/ts-node

In your CDK app entry point (e.g., `bin/app.ts`), add the bootstrap as
the every first entry:

```typescript
import "cdk-local-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
```

#### Bun

If you run your CDK app with Bun, you must preload the bootstrap. Bun snapshots CommonJS named exports during static ESM import linking, so a normal `import "cdk-local-lambda/bootstrap"` in your app entry point is too late.

Add a `--preload` command to `cdk.json`:

```json
{
  "app": "bun --preload cdk-local-lambda/bootstrap bin/app.ts"
}
```

### 2. Add the aspect to your CDK app

In your CDK app entry point (e.g., `bin/app.ts`):

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

The daemon deploys your stack with live mode enabled and runs your Lambda functions locally:

```bash
npx cdk-local-lambda local
```

If you have multiple stacks:

```bash
npx cdk-local-lambda local --stacks MyStack
```

Use `--profile` and `--region` to specify AWS credentials:

```bash
npx cdk-local-lambda local --stacks MyStack --profile my-profile --region us-west-2
```

### Manual bootstrap (optional)

If you prefer to deploy the bootstrap stack separately:

```bash
npx cdk-local-lambda bootstrap --profile my-profile --region us-west-2
```

## Common issues

1. You see: "No functions found with live-lambda tags yet. Have you patched your CDK project (bootstrap) and added the LiveLambdaAspect?"

Make sure your CDK app loads `cdk-local-lambda/bootstrap` (Bun: use `--preload cdk-local-lambda/bootstrap`) and that you call `applyLiveLambdaAspect(app)` in your app entry point.
