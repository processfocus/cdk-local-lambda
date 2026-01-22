# Testing

Framework: Bun's built-in test runner.

## Commands

```bash
# Run all tests
bun run test

# Run single file
bun test test/hello.test.ts

# Run by name pattern
bun test --test-name-pattern "should transform lambda"

# Watch mode
bun test --watch test/hello.test.ts

# Coverage
bun test --coverage
```

## Test File Structure

```typescript
import { expect, test } from "bun:test"
import { Hello } from "../src"

test("hello", () => {
  expect(new Hello().sayHello()).toBe("hello, world!")
})
```

## Test Locations

- `test/` directory
- `src/**/*.test.ts` (co-located)

## Example Stack

The `examples/complete/` directory contains a working CDK stack for testing changes.

```bash
cd examples/complete && bun install

# Run local command against example stack
bun ../../lib/cli/index.js local

# With options
bun ../../lib/cli/index.js local --profile myprofile --region us-west-2
```
