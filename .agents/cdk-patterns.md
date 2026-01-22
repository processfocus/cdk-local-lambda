# CDK Patterns

## Props Interfaces

Always define props with JSDoc:

```typescript
/**
 * Properties for LiveLambdaAspect
 */
export interface LiveLambdaAspectProps {
  /**
   * The stack name for channel routing.
   * @default - uses the function's stack name
   */
  stackName?: string
}
```

## CDK Aspects

```typescript
export class LiveLambdaAspect implements cdk.IAspect {
  private readonly props: LiveLambdaAspectProps
  private readonly processedFunctions: Set<string> = new Set()

  visit(node: IConstruct): void {
    // Implementation
  }
}
```

## CDK Stacks

```typescript
export class CdkLocalLambdaBootstrapStack extends cdk.Stack {
  public readonly api: appsync.CfnApi

  constructor(scope: Construct, id: string, props?: Props) {
    super(scope, id, props)
  }
}
```
