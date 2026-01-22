# AGENTS.md

CLI and CDK Aspect for running Lambda functions locally via AppSync Events WebSocket relay.

## Essentials

- **Package manager:** Bun
- **Build:** `bun run build` (compile + test + lint)
- **Test:** `bun run test`
- **Lint/Format:** `bun run lint:fix` / `bun run format`
- **Projen-managed:** Edit `.projenrc.ts`, then `bun run projen`

## Key Constraints

- Use `.js` extension for relative imports (ESM)
- Use `node:` prefix for Node.js built-ins
- Use Node.js 24 everywhere (Docker, Lambda runtimes)
- Biome for linting (not ESLint)

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for system design and message flow.

## Topic Guides

- [Testing](.agents/testing.md) - Test runner, patterns, example stack
- [Code Style](.agents/code-style.md) - Imports, error handling, logging, JSDoc
- [CDK Patterns](.agents/cdk-patterns.md) - Aspects, stacks, props interfaces
- [Project Structure](.agents/project-structure.md) - Directory layout, config files
