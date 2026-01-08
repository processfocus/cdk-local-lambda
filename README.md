# Local Live Lambda

CLI and CDK Aspect to deploy a CDK stack with Lambda functions running locally.

## Installation

```bash
bun install local-live-lambda
```

## Usage

### 1. Bootstrap the infrastructure

First, deploy the bootstrap stack which creates the shared AppSync Events API:

```bash
# Using default AWS profile and region
bun src/cli/index.ts bootstrap

# With specific profile and region
bun src/cli/index.ts bootstrap --profile my-profile --region us-west-2
```

Or if installed globally:

```bash
local-lambda bootstrap --profile my-profile --region us-west-2
```

### 2. Add the aspect to your CDK app

In your CDK app entry point (e.g., `bin/app.ts`):

```typescript
import "local-live-lambda/aspect/live-lambda-bootstrap" // Must be first import!
import * as cdk from "aws-cdk-lib"
import { applyLiveLambdaAspect } from "local-live-lambda"

const app = new cdk.App()
const stack = new MyStack(app, "MyStack")

// Apply the aspect when CDK_LIVE=true
applyLiveLambdaAspect(app)
```

### 3. Deploy with live mode enabled

```bash
CDK_LIVE=true cdk deploy
```

### 4. Start the local daemon (coming soon)

```bash
local-lambda daemon
```
