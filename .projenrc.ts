import { github, javascript, typescript } from "projen"

const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "trunk",
  name: "cdk-local-lambda",
  packageManager: javascript.NodePackageManager.BUN,
  projenrcTs: true,
  eslint: false,
  jest: false, // Use Bun's built-in test runner instead

  // Package metadata
  description:
    "Run lambdas in CDK stack locally to speed up debugging and improve your DX",
  repository: "https://github.com/processfocus/cdk-local-lambda.git",
  homepage: "https://github.com/processfocus/cdk-local-lambda#readme",
  authorName: "Berend de Boer",
  bugsUrl: "https://github.com/processfocus/cdk-local-lambda/issues",
  keywords: [
    "aws",
    "aws-cdk",
    "lambda",
    "cdk",
    "local-development",
    "serverless",
    "appsync",
    "docker",
    "typescript",
  ],

  // Enable npm publishing with trusted publishing (OIDC)
  releaseToNpm: true,
  npmAccess: javascript.NpmAccess.PUBLIC,
  npmProvenance: true,
  workflowNodeVersion: "24.x",
  npmTrustedPublishing: true,

  // Use GITHUB_TOKEN for dependency upgrades (no separate PAT needed)
  depsUpgradeOptions: {
    workflowOptions: {
      projenCredentials: github.GithubCredentials.fromPersonalAccessToken({
        secret: "GITHUB_TOKEN",
      }),
    },
  },

  // Enable ESM package type
  entrypoint: "lib/index.js",
  entrypointTypes: "lib/index.d.ts",

  // Use ESM for import.meta support
  tsconfig: {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2024",
      lib: ["ES2024"],
      skipLibCheck: true, // Skip type checking of declaration files to avoid @effect/platform-bun errors
      noUncheckedIndexedAccess: false,
      noPropertyAccessFromIndexSignature: false,
      exactOptionalPropertyTypes: true,
    },
  },
  tsconfigDev: {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2024",
      lib: ["ES2024"],
      skipLibCheck: true,
      noUncheckedIndexedAccess: false,
      noPropertyAccessFromIndexSignature: false,
      exactOptionalPropertyTypes: false,
    },
  },

  deps: [
    "effect",
    "@effect/cli",
    "@effect/platform",
    "@effect/platform-bun",
    "aws-cdk-lib",
    // constructs is added automatically as a peer dep of aws-cdk-lib
    // AWS SDK for bridge functions
    "@aws-sdk/signature-v4",
    "@aws-crypto/sha256-js",
    "@aws-sdk/credential-provider-node",
    "@aws-sdk/protocol-http",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-ssm",
    "@aws-sdk/client-lambda",
    "ws",
    "chokidar",
  ],
  devDeps: [
    "@effect/language-service",
    "aws-cdk",
    "@types/aws-lambda",
    "@types/node@24",
    "@types/ws",
    "@types/bun",
    "husky",
    "tsx", // Use tsx instead of ts-node (ts-node fails with ESM + Node 18.19+)
  ],
})

// Override default task to use tsx instead of ts-node (fixes ESM compatibility)
// See: https://github.com/projen/projen/issues/3388
project.defaultTask?.reset("tsx .projenrc.ts")

// Bundle bridge handler after TypeScript compilation
// This pre-bundles the bridge so users don't need to compile it at CDK synth time
project.postCompileTask.exec(
  "mkdir -p lib/functions/bridge && bun build src/functions/bridge/handler.ts --outfile=lib/functions/bridge/index.js --target=node --format=cjs --bundle --external=@aws-sdk/*",
)

// Bundle Docker bridge runtime to src/, then copy whole directory to lib/
// This way __dirname/../functions/bridge-docker works from both src/ and lib/
project.postCompileTask.exec(
  "bun build src/functions/bridge-docker/runtime.ts --outfile=src/functions/bridge-docker/runtime.js --target=node --format=cjs --bundle",
)
project.postCompileTask.exec(
  "mkdir -p lib/functions/bridge-docker && cp src/functions/bridge-docker/* lib/functions/bridge-docker/",
)

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

// Override test task to use Bun's test runner (unit tests only)
project.testTask.reset("bun test ./test/*.test.ts ./test/shared/*.test.ts")
project.addTask("test:watch", {
  description: "Run unit tests in watch mode",
  exec: "bun test --watch ./test/*.test.ts ./test/shared/*.test.ts",
})
project.addTask("test:integration", {
  description: "Run integration tests (requires deployed stack)",
  exec: "bun test ./test/integration/*.test.ts",
})

// Add bin entry for CLI
project.addBins({ cll: "lib/cli/index.js" })

// Set package type to module for ESM support
project.package.addField("type", "module")

// Add CDK, direnv, test output, and build artifacts to gitignore
project.gitignore.addPatterns(
  "cdk.out/",
  ".envrc",
  "test-reports/",
  "src/functions/bridge-docker/runtime.js",
)

// Add husky prepare script for git hooks
project.package.setScript("prepare", "husky")

// Configure PR title validation - allowed conventional commit types
project.github
  ?.tryFindWorkflow("pull-request-lint")
  ?.file?.addOverride(
    "jobs.validate.steps.0.with.types",
    "ci\ndocs\nfeat\nfix\nchore\nrefactor\ntest\nvendor",
  )

// Fix upgrade-trunk workflow permissions for GITHUB_TOKEN to create PRs
project.github
  ?.tryFindWorkflow("upgrade-trunk")
  ?.file?.addOverride("jobs.pr.permissions", {
    contents: "write",
    "pull-requests": "write",
  })

// Specify files to include in npm package
project.package.addField("files", ["lib", "LICENSE", "README.md"])

// Add exports field for clean subpath imports
project.package.addField("exports", {
  ".": {
    types: "./lib/index.d.ts",
    import: "./lib/index.js",
  },
  "./bootstrap": {
    types: "./lib/aspect/live-lambda-bootstrap.d.ts",
    import: "./lib/aspect/live-lambda-bootstrap.js",
  },
  "./package.json": "./package.json",
})

project.synth()
