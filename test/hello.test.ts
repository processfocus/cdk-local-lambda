import { expect, test } from "bun:test"
import { isLiveModeEnabled, LiveLambdaAspect } from "../src"

test("isLiveModeEnabled returns false when CDK_LIVE is not set", () => {
  delete process.env.CDK_LIVE
  expect(isLiveModeEnabled()).toBe(false)
})

test("isLiveModeEnabled returns true when CDK_LIVE is true", () => {
  process.env.CDK_LIVE = "true"
  expect(isLiveModeEnabled()).toBe(true)
  delete process.env.CDK_LIVE
})

test("LiveLambdaAspect can be instantiated", () => {
  const aspect = new LiveLambdaAspect()
  expect(aspect).toBeInstanceOf(LiveLambdaAspect)
})
