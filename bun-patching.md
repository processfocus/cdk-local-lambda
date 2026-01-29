# Bun Module Patching (Bun)

## Problem

Our bootstrap (`src/aspect/live-lambda-bootstrap.ts`) patches CDK constructs at runtime so we can capture:

- `NodejsFunction` `entry` + `handler`
- `DockerImageFunction` docker context

This is straightforward in Node.js (`Module._load` hook). In Bun it is possible, but only if the patch runs **before the app entry point is loaded**.

## Why Bun Is Different

Two Bun behaviors matter here:

1. Bun does **not** expose Node's `Module._load` hook.
2. When importing a CommonJS module from ESM, Bun creates **snapshots** of *named* exports (not live bindings). If you patch `module.exports.NodejsFunction` after Bun has linked `import { NodejsFunction } ...`, that import won't update.

This matches Bun issue `oven-sh/bun#5511` ("snapshot" behavior for CJS named exports imported from ESM).

## What Works

### Preload the bootstrap (recommended)

Run Bun with the bootstrap preloaded:

```bash
CDK_LIVE=true bun --preload local-live-lambda/bootstrap bin/app.ts
```

Preloading ensures Bun snapshots the already-patched CommonJS exports.

### Two-step entry (no CLI flags)

If you can't use `--preload`, make a tiny entry point that installs the bootstrap and then dynamically imports your real app:

```ts
import "local-live-lambda/bootstrap"
await import("./app.js")
```

Dynamic import happens after the patch code has run.

## Quick Verification

```bash
CDK_LIVE=true bun --preload local-live-lambda/bootstrap -e "
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
console.log('Patched:', NodejsFunction.__liveLambdaPatched) // true
"
```

Without `--preload`, the same snippet will typically print `undefined` because the static import was linked before the patch ran.
