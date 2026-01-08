import { javascript, typescript } from "projen"

const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "main",
  name: "local-live-lambda",
  packageManager: javascript.NodePackageManager.BUN,
  projenrcTs: true,
  eslint: false,

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
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

project.synth()
