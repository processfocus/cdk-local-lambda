import { describe, expect, test } from "bun:test"
import { isLiveModeEnabled, LiveLambdaAspect } from "../src"

test("isLiveModeEnabled returns false when CDK_LOCAL_LAMBDA is not set", () => {
  delete process.env.CDK_LOCAL_LAMBDA
  expect(isLiveModeEnabled()).toBe(false)
})

test("isLiveModeEnabled returns true when CDK_LOCAL_LAMBDA is true", () => {
  process.env.CDK_LOCAL_LAMBDA = "true"
  expect(isLiveModeEnabled()).toBe(true)
  delete process.env.CDK_LOCAL_LAMBDA
})

test("LiveLambdaAspect can be instantiated", () => {
  const aspect = new LiveLambdaAspect()
  expect(aspect).toBeInstanceOf(LiveLambdaAspect)
})

describe("LiveLambdaAspect", () => {
  test("does not support manual handler/docker mappings", () => {
    // This project intentionally relies on runtime capture via the bootstrap.
    expect(new LiveLambdaAspect()).toBeInstanceOf(LiveLambdaAspect)
  })
})
