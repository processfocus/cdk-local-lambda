# Local Live Lambda

CLI and CDK Aspect to deploy a CDK stack with Lambda functions running locally.

## Installation

```bash
npm install local-live-lambda
```

## Usage

### 1. Add the aspect to your CDK app

In your CDK app entry point (e.g., `bin/app.ts`):

```typescript
import "local-live-lambda/bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "local-live-lambda"

const app = new cdk.App()
const stack = new MyStack(app, "MyStack")

applyLiveLambdaAspect(app)
```

### 2. Start the local daemon

The daemon deploys your stack with live mode enabled and runs your Lambda functions locally:

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
