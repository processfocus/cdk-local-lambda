/**
 * File watching for hot-reload support.
 *
 * Watches handler files and triggers rebuilds when they change.
 */

import chokidar from "chokidar"
import { Effect, Stream } from "effect"

/**
 * File change event.
 */
export interface FileChangeEvent {
  type: "add" | "change" | "unlink"
  path: string
}

/**
 * Create a file watcher stream that emits events when files change.
 *
 * @param patterns - Glob patterns to watch (e.g., ["src/**\/*.ts"])
 * @param options - Chokidar options
 */
export const watchFiles = (
  patterns: string | string[],
  options?: Parameters<typeof chokidar.watch>[1],
): Stream.Stream<FileChangeEvent, Error> =>
  Stream.asyncScoped<FileChangeEvent, Error>((emit) =>
    Effect.gen(function* () {
      const watcher = chokidar.watch(patterns, {
        ignoreInitial: true,
        ...options,
      })

      watcher.on("add", (path) => {
        emit.single({ type: "add", path })
      })

      watcher.on("change", (path) => {
        emit.single({ type: "change", path })
      })

      watcher.on("unlink", (path) => {
        emit.single({ type: "unlink", path })
      })

      watcher.on("error", (err) => {
        const error = err as Error
        emit.fail(new Error(`Watcher error: ${error.message}`))
      })

      // Cleanup when scope closes
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await watcher.close()
          console.log("[Watcher] File watcher closed")
        }),
      )

      console.log(
        `[Watcher] Watching: ${Array.isArray(patterns) ? patterns.join(", ") : patterns}`,
      )
    }),
  )

/**
 * Watch for changes to handler files and debounce notifications.
 *
 * @param patterns - Glob patterns to watch
 * @param debounceMs - Debounce delay in milliseconds (default: 500)
 */
export const watchHandlerFiles = (
  patterns: string | string[],
  debounceMs = 500,
): Stream.Stream<FileChangeEvent[], Error> =>
  watchFiles(patterns).pipe(
    // Collect events within the debounce window
    Stream.debounce(`${debounceMs} millis`),
    Stream.map((event) => [event]),
  )

/**
 * Watch a directory and accumulate changes.
 */
export const watchDirectory = (
  directory: string,
  extensions = ["ts", "js", "mjs", "cjs", "json"],
): Stream.Stream<FileChangeEvent[], Error> => {
  const pattern = `${directory}/**/*.{${extensions.join(",")}}`
  return watchHandlerFiles(pattern)
}
