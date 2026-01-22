/**
 * JavaScript example handler for Live Lambda.
 * Demonstrates a simple calculator function.
 */

/**
 * @param {{ a: number, b: number, op: 'add' | 'subtract' | 'multiply' | 'divide' }} event
 * @returns {Promise<{ result: number, operation: string }>}
 */
export const calculate = async (event) => {
  const { a, b, op } = event

  console.log(`[Calculator] Calculating: ${a} ${op} ${b}`)

  let result
  switch (op) {
    case "add":
      result = a + b
      break
    case "subtract":
      result = a - b
      break
    case "multiply":
      result = a * b
      break
    case "divide":
      if (b === 0) {
        throw new Error("Division by zero")
      }
      result = a / b
      break
    default:
      throw new Error(`Unknown operation: ${op}`)
  }

  return {
    result,
    operation: `${a} ${op} ${b} = ${result}`,
  }
}
