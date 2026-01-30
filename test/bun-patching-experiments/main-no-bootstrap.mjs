import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"

console.log("patched?", NodejsFunction.__patched)
