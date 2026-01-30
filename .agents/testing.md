# Testing

Framework: Bun's built-in test runner.

## Commands

```bash
# Run unit tests only (default - fast, no external dependencies)
bun run test

# Run integration tests (requires deployed AWS stack)
bun run test:integration

# Run unit tests in watch mode
bun run test:watch

# Run single file
bun test test/hello.test.ts

# Run by name pattern
bun test --test-name-pattern "should transform lambda"

# Coverage
bun test --coverage
```

## Test Organization

Tests are organized into two categories:

### Unit Tests (`test/*.test.ts`, `test/shared/*.test.ts`)
Fast, isolated tests that don't require external services:
- Runtime API behavior
- Docker container configuration
- Environment variable handling
- Aspect/CDK transformations

### Integration Tests (`test/integration/*.test.ts`)
Slower tests that require deployed infrastructure:
- AppSync WebSocket client tests
- Bridge Lambda handler tests
- End-to-end flow tests
- CDK preload integration tests

**Integration tests require a deployed bootstrap stack** and will fail locally without AWS credentials and infrastructure.

## Test File Structure

```typescript
import { expect, test } from "bun:test"
import { Hello } from "../src"

test("hello", () => {
  expect(new Hello().sayHello()).toBe("hello, world!")
})
```

## Test Locations

- `test/` directory for unit tests
- `test/integration/` directory for integration tests
- `test/shared/` for shared test utilities
- `src/**/*.test.ts` for co-located tests

## Example Stack

The `examples/complete/` directory contains a working CDK stack for testing changes.

```bash
cd examples/complete && bun install

# Run local command against example stack
bun ../../lib/cli/index.js local

# With options
bun ../../lib/cli/index.js local --profile myprofile --region us-west-2
```
