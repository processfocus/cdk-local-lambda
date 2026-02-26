/**
 * Simple echo handler running as a Bun HTTP server.
 *
 * This handler uses AWS Lambda Web Adapter to run as a standard HTTP server
 * inside Lambda, demonstrating the live debugging workflow with DockerImageFunction.
 */

interface EchoResponse {
  message: string
  event: unknown
  requestId: string
  timestamp: string
}

const PORT = Number(process.env.PORT) || 8080

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    // Readiness check endpoint for Lambda Web Adapter
    const url = new URL(request.url)
    if (url.pathname === "/healthz") {
      return new Response("OK", { status: 200 })
    }

    // Lambda Web Adapter sends the event as POST body to the root path
    // and includes Lambda context in headers
    const requestId =
      request.headers.get("x-amzn-request-id") ||
      request.headers.get("x-request-id") ||
      crypto.randomUUID()

    console.log(`[Echo] Received request: ${request.method} ${request.url}`)

    let event: unknown = null
    if (request.method === "POST") {
      try {
        event = await request.json()
      } catch {
        event = await request.text()
      }
    }

    console.log("[Echo] Event:", JSON.stringify(event))

    const response: EchoResponse = {
      message: "Hello from the echo handler!",
      event,
      requestId,
      timestamp: new Date().toISOString(),
    }

    console.log("[Echo] Returning response:", JSON.stringify(response))

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  },
})

console.log(`[Echo] Server listening on port ${server.port}`)
