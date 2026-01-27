/**
 * Types for Docker container management.
 */

/**
 * Configuration for running a Docker container.
 */
export interface DockerRunConfig {
  /** The Docker image URI to run */
  imageUri: string
  /** Container name (optional) */
  containerName?: string
  /** Platform (e.g., linux/arm64, linux/amd64) for cross-platform execution */
  platform?: string
  /** Environment variables to pass to the container */
  environment: Record<string, string>
  /** Memory limit in MB */
  memoryMB: number
  /** Timeout in seconds */
  timeoutSeconds: number
  /** Network mode (bridge, host, none) */
  networkMode: "bridge" | "host" | "none"
  /** Extra host entries (--add-host) */
  extraHosts?: string[]
  /** Working directory inside the container */
  workdir?: string
  /** Additional Docker run arguments */
  additionalArgs?: string[]
  /** Optional invocation context map for log prefixing (requestId -> { num }) */
  invocationContexts?: Map<string, { num: number }>
}

/**
 * Result of running a Docker container.
 */
export interface DockerRunResult {
  /** Exit code of the container */
  exitCode: number
  /** Stdout from the container */
  stdout: string
  /** Stderr from the container */
  stderr: string
}

/**
 * Docker runtime detection result.
 */
export interface DockerRuntimeInfo {
  /** Path to Docker executable */
  dockerPath: string
  /** Whether running on Linux */
  isLinux: boolean
  /** Whether running in WSL */
  isWsl: boolean
  /** Whether Docker Desktop is detected */
  isDockerDesktop: boolean
  /** Host address to use for container-to-host communication */
  hostAddress: string
}
