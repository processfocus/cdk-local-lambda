/**
 * Stub for daemon logic.
 *
 * The daemon will:
 * 1. Connect to AppSync Events
 * 2. Subscribe to invocation channels for discovered Lambda functions
 * 3. Execute local handlers when invocations arrive
 * 4. Publish responses back to the bridge
 */

import { Effect } from "effect"

export interface DaemonConfig {
  profile?: string
  region?: string
  stackName?: string
}

/**
 * Start the local daemon.
 *
 * @param config - Configuration for the daemon
 * @returns Effect that fails with "not implemented" error
 */
export const startDaemon = (
  _config: DaemonConfig,
): Effect.Effect<void, Error> =>
  Effect.fail(new Error("Daemon not yet implemented"))
