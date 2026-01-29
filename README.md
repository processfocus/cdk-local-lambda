# Local Live Lambda

CLI and CDK Aspect to deploy a CDK stack with Lambda functions running locally.

## Installation

```bash
npm install local-live-lambda
```

## Usage

### 1. Add the bootstrap to your CDK app

Unfortunately CDK hides lambda internals which we need to know. Until
CDK accepts our patch to improve this, you need to live patch
CDK. This depends on now you run your CDK app.

#### tsx/ts-node

In your CDK app entry point (e.g., `bin/app.ts`), add the bootstrap as
the every first entry:

```typescript
import "local-live-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
```

#### Bun

If you run your CDK app with Bun, you must preload the bootstrap. Bun snapshots CommonJS named exports during static ESM import linking, so a normal `import "local-live-lambda/bootstrap"` in your app entry point is too late.

Add a `--preload` command to `cdk.json`:

```json
{
  "app": "bun --preload local-live-lambda/bootstrap bin/app.ts"
}
```

### 2. Add the aspect to your CDK app

In your CDK app entry point (e.g., `bin/app.ts`):

```typescript
import "local-live-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "local-live-lambda"

const app = new cdk.App()
const stack = new MyStack(app, "MyStack")

applyLiveLambdaAspect(app)
```

### 3. Start the local daemon

The daemon deploys your stack with live mode enabled and runs your Lambda functions locally:

```bash
npx local-lambda local
```

If you have multiple stacks:

```bash
npx local-lambda local --stacks MyStack
```

Use `--profile` and `--region` to specify AWS credentials:

```bash
npx local-lambda local --stacks MyStack --profile my-profile --region us-west-2
```

### Manual bootstrap (optional)

If you prefer to deploy the bootstrap stack separately:

```bash
npx local-lambda bootstrap --profile my-profile --region us-west-2
```
