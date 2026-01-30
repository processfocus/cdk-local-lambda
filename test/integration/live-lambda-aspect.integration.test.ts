import { describe, expect, it } from "bun:test"

const isBun = typeof process.versions.bun !== "undefined"

describe("LiveLambdaAspect (integration via preload)", () => {
  it("transforms NodejsFunction and DockerImageFunction when bootstrap is preloaded", () => {
    if (!isBun) {
      expect(isBun).toBe(false)
      return
    }

    const proc = Bun.spawnSync(
      [
        "bun",
        "--preload",
        "cdk-local-lambda/bootstrap",
        "-e",
        `import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LiveLambdaAspect } from 'cdk-local-lambda';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'TestStack');

new NodejsFunction(stack, 'TsFn', { entry: 'test/fixtures/handler.ts', handler: 'main' });
new lambda.DockerImageFunction(stack, 'DockerFn', { code: lambda.DockerImageCode.fromImageAsset('test/fixtures/docker') });

cdk.Aspects.of(stack).add(new LiveLambdaAspect());

const asm = app.synth({ force: true, validateOnSynthesis: false });
const tpl = asm.getStackArtifact('TestStack').template;
const resources = Object.values(tpl.Resources);

const tagsFor = (r) => (r.Properties?.Tags ?? []);
const hasTag = (tags, key) => tags.some((t) => t.Key === key);

const nodeFn = resources.find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.PackageType !== 'Image');
const dockerFn = resources.find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.PackageType === 'Image');

if (!nodeFn || !dockerFn) {
  console.log('MISSING');
  process.exit(2);
}

const ok =
  hasTag(tagsFor(nodeFn), 'live-lambda:handler') &&
  hasTag(tagsFor(dockerFn), 'live-lambda:docker-context');

console.log(ok ? 'OK' : 'BAD');
`,
      ],
      {
        env: {
          ...process.env,
          CDK_LOCAL_LAMBDA: "true",
        },
      },
    )

    expect(proc.exitCode).toBe(0)
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    expect(stdout.endsWith("OK")).toBe(true)
  })
})
