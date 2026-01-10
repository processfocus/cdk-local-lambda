/**
 * Unit tests for shared types and utility functions.
 */

import { describe, expect, it } from "bun:test"
import { buildChannelName, hashFunctionName } from "../../src/shared/types"

describe("hashFunctionName", () => {
  it("returns 16 hex characters", () => {
    const hash = hashFunctionName("my-function")
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })

  it("is deterministic", () => {
    const hash1 = hashFunctionName("my-function")
    const hash2 = hashFunctionName("my-function")
    expect(hash1).toBe(hash2)
  })

  it("produces different hashes for different inputs", () => {
    const hash1 = hashFunctionName("function-a")
    const hash2 = hashFunctionName("function-b")
    expect(hash1).not.toBe(hash2)
  })

  it("handles long function names", () => {
    const longName = "a".repeat(256)
    const hash = hashFunctionName(longName)
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })

  it("handles special characters", () => {
    const hash = hashFunctionName("my-function_v2:latest")
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })
})

describe("buildChannelName", () => {
  describe("invocation", () => {
    it("returns correct path structure", () => {
      const channel = buildChannelName.invocation("my-function")
      expect(channel).toMatch(/^\/live\/[a-f0-9]{16}\/in$/)
    })

    it("uses hashed function name", () => {
      const channel = buildChannelName.invocation("my-function")
      const expectedHash = hashFunctionName("my-function")
      expect(channel).toBe(`/live/${expectedHash}/in`)
    })

    it("produces different channels for different functions", () => {
      const channel1 = buildChannelName.invocation("function-a")
      const channel2 = buildChannelName.invocation("function-b")
      expect(channel1).not.toBe(channel2)
    })
  })

  describe("response", () => {
    it("returns correct path structure", () => {
      const channel = buildChannelName.response("my-function")
      expect(channel).toMatch(/^\/live\/[a-f0-9]{16}\/out$/)
    })

    it("uses hashed function name", () => {
      const channel = buildChannelName.response("my-function")
      const expectedHash = hashFunctionName("my-function")
      expect(channel).toBe(`/live/${expectedHash}/out`)
    })

    it("produces different channels for different functions", () => {
      const channel1 = buildChannelName.response("function-a")
      const channel2 = buildChannelName.response("function-b")
      expect(channel1).not.toBe(channel2)
    })
  })

  it("invocation and response use same hash for same function", () => {
    const invocationChannel = buildChannelName.invocation("my-function")
    const responseChannel = buildChannelName.response("my-function")
    const hash = hashFunctionName("my-function")
    expect(invocationChannel).toContain(hash)
    expect(responseChannel).toContain(hash)
  })
})
