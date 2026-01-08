import { javascript, typescript } from "projen"

const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "main",
  name: "local-live-lambda",
  packageManager: javascript.NodePackageManager.BUN,
  projenrcTs: true,
  eslint: false,

  // Enable ESM package type
  entrypoint: "lib/index.js",
  entrypointTypes: "lib/index.d.ts",

  // Use ESM for import.meta support
  tsconfig: {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2022",
      lib: ["ES2022"],
      skipLibCheck: true, // Skip type checking of declaration files to avoid @effect/platform-bun errors
    },
  },
  tsconfigDev: {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2022",
      lib: ["ES2022"],
      skipLibCheck: true,
    },
  },

  deps: [
    "effect",
    "@effect/cli",
    "@effect/platform",
    "@effect/platform-bun",
    "aws-cdk-lib",
    "constructs",
    // AWS SDK for bridge functions
    "@aws-sdk/signature-v4",
    "@aws-crypto/sha256-js",
    "@aws-sdk/credential-provider-node",
    "@aws-sdk/protocol-http",
    "@aws-sdk/client-s3",
    "ws",
  ],
  devDeps: [
    "@effect/language-service",
    "aws-cdk",
    "@types/aws-lambda",
    "@types/ws",
    "@types/bun",
  ],

  // Use bun to run projenrc for ESM compatibility
  projenCommand: "bun .projenrc.ts",
})

// Add Biome for linting and formatting
project.addDevDeps("@biomejs/biome")
project.addTask("lint", {
  description: "Run Biome linter",
  exec: "biome check .",
})
project.addTask("format", {
  description: "Format code with Biome",
  exec: "biome format --write .",
})
project.addTask("lint:fix", {
  description: "Fix linting issues with Biome",
  exec: "biome check --write .",
})

// Add bin entry for CLI
project.addBins({ "local-lambda": "lib/cli/index.js" })

// Set package type to module for ESM support
project.package.addField("type", "module")

// Add CDK and direnv files to gitignore
project.gitignore.addPatterns("cdk.out/", ".envrc")

project.synth()
