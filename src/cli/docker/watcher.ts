/**
 * Docker context file watching for automatic container rebuilds.
 *
 * Watches Docker context directories and emits events when files change,
 * triggering container rebuilds for Docker-based Lambda functions.
 */

import * as path from "node:path"
import chokidar from "chokidar"
import { Effect, Stream } from "effect"

/**
 * Event emitted when a file changes in a Docker context.
 */
export interface DockerContextChangeEvent {
  /** The function ID that owns this Docker context */
  functionId: string
  /** The absolute path to the file that changed */
  filePath: string
  /** Type of change */
  type: "add" | "change" | "unlink"
}

/**
 * Configuration for a Docker function to watch.
 */
export interface WatchedDockerFunction {
  /** Unique function identifier (Lambda function name) */
  functionId: string
  /** Absolute path to the Docker context directory */
  dockerContextPath: string
}

/**
 * Default patterns to ignore when watching Docker contexts.
 * These are common directories/files that shouldn't trigger rebuilds.
 */
const DEFAULT_IGNORED_PATTERNS = [
  /(^|[/\\])\.git([/\\]|$)/, // .git directory
  /(^|[/\\])node_modules([/\\]|$)/, // node_modules
  /(^|[/\\])\.[^/\\]+$/, // dotfiles (but not directories like .docker)
  /\.pyc$/, // Python bytecode
  /__pycache__/, // Python cache
  /\.class$/, // Java bytecode
  /\.o$/, // Object files
  /\.log$/, // Log files
]

/**
 * Watch multiple Docker context directories for file changes.
 *
 * Creates a single chokidar watcher that monitors all registered Docker
 * contexts and emits events when files change. The events are debounced
 * to prevent rapid successive rebuilds during batch operations.
 *
 * @param functions - Array of Docker functions to watch
 * @param debounceMs - Debounce delay in milliseconds (default: 500)
 * @returns Stream of change events with function ownership resolved
 */
export const watchDockerContexts = (
  functions: WatchedDockerFunction[],
  debounceMs = 500,
): Stream.Stream<DockerContextChangeEvent, Error> => {
  if (functions.length === 0) {
    return Stream.empty
  }

  // Build a map of normalized context paths to function IDs for quick lookup
  const contextToFunction = new Map<string, string>()
  const pathsToWatch: string[] = []

  for (const fn of functions) {
    const normalizedPath = path.normalize(fn.dockerContextPath)
    contextToFunction.set(normalizedPath, fn.functionId)
    pathsToWatch.push(fn.dockerContextPath)
  }

  return Stream.asyncScoped<DockerContextChangeEvent, Error>((emit) =>
    Effect.gen(function* () {
      const watcher = chokidar.watch(pathsToWatch, {
        ignored: DEFAULT_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        // Use polling on some systems for better reliability
        usePolling: process.platform === "linux",
        interval: 300,
      })

      /**
       * Find which function owns a given file path.
       */
      const findOwningFunction = (filePath: string): string | undefined => {
        const normalizedFilePath = path.normalize(filePath)

        for (const [contextPath, functionId] of contextToFunction) {
          if (normalizedFilePath.startsWith(contextPath + path.sep)) {
            return functionId
          }
          // Also match if the file IS the context directory (shouldn't happen but handle it)
          if (normalizedFilePath === contextPath) {
            return functionId
          }
        }
        return undefined
      }

      /**
       * Handle a file change event.
       */
      const handleChange = (
        type: "add" | "change" | "unlink",
        filePath: string,
      ) => {
        const functionId = findOwningFunction(filePath)
        if (functionId) {
          emit.single({
            functionId,
            filePath,
            type,
          })
        }
      }

      watcher.on("add", (filePath) => handleChange("add", filePath))
      watcher.on("change", (filePath) => handleChange("change", filePath))
      watcher.on("unlink", (filePath) => handleChange("unlink", filePath))

      watcher.on("error", (err) => {
        const error = err as Error
        Effect.runSync(
          Effect.logWarning(`DockerWatcher error: ${error.message}`),
        )
        // Don't fail the stream on transient errors, just log
      })

      watcher.on("ready", () => {
        Effect.runSync(
          Effect.logInfo(
            `Watching ${functions.length} Docker context(s) for changes`,
          ),
        )
        for (const fn of functions) {
          Effect.runSync(
            Effect.logInfo(`  - ${fn.functionId}: ${fn.dockerContextPath}`),
          )
        }
      })

      // Cleanup when scope closes
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await watcher.close()
          })
          yield* Effect.logInfo("DockerWatcher file watcher closed")
        }),
      )
    }),
  ).pipe(
    // Debounce to handle batch file changes (e.g., git checkout, IDE save-all)
    Stream.debounce(`${debounceMs} millis`),
  )
}

/**
 * Create a watcher for a single Docker function.
 * Convenience wrapper around watchDockerContexts for single-function use.
 */
export const watchSingleDockerContext = (
  functionId: string,
  dockerContextPath: string,
  debounceMs = 500,
): Stream.Stream<DockerContextChangeEvent, Error> =>
  watchDockerContexts([{ functionId, dockerContextPath }], debounceMs)
