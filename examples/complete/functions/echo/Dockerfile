# Node.js-based Lambda container for the echo handler
# This uses the official Lambda Node.js runtime image

FROM oven/bun:1 AS builder

WORKDIR /build

# Copy and install dependencies (if any)
COPY handler.ts .

# Bundle the handler for Node.js (CJS for Lambda runtime)
RUN bun build handler.ts --outfile=handler.js --target=node --format=cjs

# Production image based on AWS Lambda Node.js runtime
FROM public.ecr.aws/lambda/nodejs:24-arm64

# Copy the bundled handler
WORKDIR /var/task
COPY --from=builder /build/handler.js .

# Lambda Node.js runtime reads the handler from CMD
CMD ["handler.handler"]
