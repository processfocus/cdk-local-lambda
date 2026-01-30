import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

// Minimal reproduction for Bun's CJS->ESM named export snapshot behavior.
//
// Goal: replace aws-cdk-lib/aws-lambda-nodejs's NodejsFunction export via CJS,
// so that subsequent ESM imports see the patched class.

const mod = require("aws-cdk-lib/aws-lambda-nodejs")
const Original = mod.NodejsFunction

class PatchedNodejsFunction extends Original {
  static __patched = true
}

Object.defineProperty(mod, "NodejsFunction", {
  value: PatchedNodejsFunction,
  writable: true,
  configurable: true,
})
