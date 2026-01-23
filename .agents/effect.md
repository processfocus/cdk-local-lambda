# Effect Best Practices

**Before implementing Effect features**, run `bunx effect-solutions list` and read the relevant guide.

Topics include: services and layers, data modeling, error handling, configuration, testing, HTTP clients, CLIs, observability, and project structure.

**Effect Source Reference:** `~/.local/share/effect-solutions/effect`
Search here for real implementations when docs aren't enough.

## Logging in the CLI Daemon

**All logging in `src/cli/` must use Effect logging** (`Effect.log`, `Effect.logDebug`, `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`). Do not use `console.log` or `console.error` in Effect code.

This ensures logs integrate with the Effect runtime for proper formatting, filtering, and observability.
