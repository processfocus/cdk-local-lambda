import { expect, test } from "bun:test"
import { Hello } from "../src"

test("hello", () => {
  expect(new Hello().sayHello()).toBe("hello, world!")
})
