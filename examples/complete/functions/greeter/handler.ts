/**
 * TypeScript example handler for Live Lambda.
 * Demonstrates a simple greeting function.
 */

interface GreetingEvent {
  name?: string
}

interface GreetingResponse {
  message: string
  timestamp: string
}

export const handler = async (
  event: GreetingEvent,
): Promise<GreetingResponse> => {
  const name = event.name || "World"

  console.log(`[Greeter] Received greeting request for: ${name}`)

  return {
    message: `Hello, ${name}!`,
    timestamp: new Date().toISOString(),
  }
}
