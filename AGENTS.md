# AGENTS.md - Coding Agent Guidelines

This file provides guidelines for AI coding agents working in this repository.

## Project Overview

Local Live Lambda is a CLI and CDK Aspect for deploying CDK stacks with Lambda functions running locally instead of in AWS. It uses AppSync Events for WebSocket communication between AWS and local development.

**Tech Stack:** TypeScript, AWS CDK, Bun, Biome, Projen

## Build Commands

This is a **projen-managed** project. All commands go through projen or npm scripts.

```bash
# Full build (compile + test + lint)
bun run build

# TypeScript compilation only
bun run compile

# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch

# Run a single test file
bun test path/to/file.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "pattern"

# Linting (Biome)
bun run lint

# Fix lint issues
bun run lint:fix

# Format code
bun run format

# Watch mode compilation
bun run watch

# Re-synthesize projen configuration
bun run projen
```

## Testing

- **Framework:** Bun's built-in test runner
- **Test location:** `test/` directory and `src/**/*.test.ts`
- **Test patterns:** `*.test.ts`, `*.spec.ts`

```bash
# Run single test file
bun test test/hello.test.ts

# Run tests matching name pattern
bun test --test-name-pattern "should transform lambda"

# Run with coverage
bun test --coverage

# Watch specific file
bun test --watch test/hello.test.ts
```

**Test file example:**
```typescript
import { expect, test } from "bun:test"
import { Hello } from "../src"

test("hello", () => {
  expect(new Hello().sayHello()).toBe("hello, world!")
})
```

## Code Style Guidelines

### Formatting (Biome)

- **Indentation:** 2 spaces
- **Line width:** 80 characters
- **Quotes:** Double quotes
- **Semicolons:** As needed (no trailing semicolons)
- **Trailing commas:** Always
- **Arrow parens:** Always required `(x) => x`
- **Bracket spacing:** `{ foo }` not `{foo}`

### Import Order and Style

```typescript
// 1. Node.js built-ins with node: prefix
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

// 2. AWS CDK namespace imports
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"

// 3. Type-only imports (use 'import type' when only importing types)
import type { IConstruct } from "constructs"
import type { Construct } from "constructs"

// 4. Relative imports with .js extension (ESM style)
import { SSM_PARAMS } from "../shared/types.js"
```

### TypeScript Conventions

- **Strict mode enabled** - all strict flags are on
- **No unused locals/parameters** - will fail compilation
- **Explicit types** for function parameters and return values
- **Use interfaces** for object shapes, especially props

```typescript
/**
 * Properties for LiveLambdaAspect
 */
export interface LiveLambdaAspectProps {
  /**
   * The stack name for channel routing.
   * @default - uses the function's stack name
   */
  stackName?: string
}
```

### Naming Conventions

- **Files:** kebab-case (`live-lambda-aspect.ts`)
- **Classes:** PascalCase (`LiveLambdaAspect`)
- **Interfaces:** PascalCase, props end with `Props` (`LiveLambdaAspectProps`)
- **Functions/methods:** camelCase (`sayHello`)
- **Constants:** UPPER_SNAKE_CASE (`SSM_PARAMS`)
- **Variables:** camelCase (`functionId`)

### Error Handling

```typescript
// Descriptive error messages with context
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

### Logging

Use console with `[LiveLambda]` prefix for context:
```typescript
console.log(`[LiveLambda] Transforming function: ${functionId}`)
console.error("[LiveLambda] FATAL: Something went wrong")
```

### CDK Patterns

```typescript
// CDK Aspects
export class LiveLambdaAspect implements cdk.IAspect {
  private readonly props: LiveLambdaAspectProps
  private readonly processedFunctions: Set<string> = new Set()

  visit(node: IConstruct): void {
    // Implementation
  }
}

// CDK Stacks
export class CdkLocalLambdaBootstrapStack extends cdk.Stack {
  public readonly api: appsync.CfnApi

  constructor(scope: Construct, id: string, props?: Props) {
    super(scope, id, props)
  }
}
```

### JSDoc Comments

Add JSDoc for exported classes, interfaces, and public methods:
```typescript
/**
 * Transforms Lambda functions to use local execution.
 * @param functionId - The unique identifier for the function
 * @returns The transformed function configuration
 */
```

## Project Structure

```
src/
├── index.ts                    # Main entry point (exports)
├── aspect/                     # CDK Aspect for Lambda transformation
├── bootstrap-stack/            # Bootstrap CDK stack
└── cli/                        # CLI implementation

test/                           # Test files
examples/                       # Example projects
```

## Configuration Files

| File | Purpose |
|------|---------|
| `.projenrc.ts` | Projen project definition (source of truth) |
| `package.json` | Generated by projen - do not edit directly |
| `tsconfig.json` | Production TypeScript config |
| `tsconfig.dev.json` | Dev/test TypeScript config |
| `biome.json` | Linting & formatting rules |

## Important Notes

1. **Projen manages config** - Edit `.projenrc.ts` then run `bun run projen`
2. **Use Bun** - This project uses Bun as package manager
3. **Biome, not ESLint** - Linting uses Biome, not ESLint
4. **ESM imports** - Use `.js` extension for relative imports
5. **Node prefix** - Use `node:` prefix for Node.js built-ins
