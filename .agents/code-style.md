# Code Style

Formatting is handled by Biome (`bun run format`). This guide covers conventions Biome doesn't enforce.

## Import Order

```typescript
// 1. Node.js built-ins (with node: prefix)
import { execSync } from "node:child_process"
import * as fs from "node:fs"

// 2. AWS CDK namespace imports
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"

// 3. Type-only imports
import type { IConstruct } from "constructs"

// 4. Relative imports (with .js extension)
import { SSM_PARAMS } from "../shared/types.js"
```

## Error Handling

```typescript
// Descriptive messages with context
throw new Error(
  `[LiveLambda] No local handler path for "${constructId}". ` +
    `This function was not created with NodejsFunction...`
)

// Try-catch for external processes
try {
  execSync(`bun build ...`, { stdio: "pipe" })
} catch (err) {
  console.error("Failed to bundle bridge handler:", err)
  throw err
}

// Fatal errors
console.error("[LiveLambda] FATAL: Cannot patch NodejsFunction...")
process.exit(1)
```

## Logging

Use `[LiveLambda]` prefix:

```typescript
console.log(`[LiveLambda] Transforming function: ${functionId}`)
console.error("[LiveLambda] FATAL: Something went wrong")
```

## JSDoc

Add JSDoc for exported APIs:

```typescript
/**
 * Transforms Lambda functions to use local execution.
 * @param functionId - The unique identifier for the function
 * @returns The transformed function configuration
 */
```

## Constants

Use UPPER_SNAKE_CASE:

```typescript
const SSM_PARAMS = { ... }
```
