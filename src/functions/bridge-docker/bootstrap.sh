#!/bin/bash
# Lambda custom runtime bootstrap for the Docker bridge handler
# This script runs the Node.js runtime wrapper which implements the Lambda Runtime API

set -euo pipefail

# Log startup
echo "[Bootstrap] Starting bridge runtime..."
echo "[Bootstrap] AWS_LAMBDA_RUNTIME_API: ${AWS_LAMBDA_RUNTIME_API:-not set}"
echo "[Bootstrap] AWS_LAMBDA_FUNCTION_NAME: ${AWS_LAMBDA_FUNCTION_NAME:-not set}"

# Run the runtime wrapper using Node.js
# The runtime.js file implements the Lambda Runtime API and calls our handler
exec node --enable-source-maps /var/task/runtime.js
