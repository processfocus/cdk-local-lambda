# Bun-based Lambda container using AWS Lambda Web Adapter
# This allows the handler to run as a standard HTTP server

FROM oven/bun:1-alpine

# Install Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app

# Copy the handler
COPY handler.ts .

# Expose server port for local testing
EXPOSE 8080

# Lambda Web Adapter expects the server to listen on PORT
ENV PORT=8080
# Use a dedicated readiness check path so health checks don't hit the handler
ENV READINESS_CHECK_PATH=/healthz

CMD ["bun", "handler.ts"]
