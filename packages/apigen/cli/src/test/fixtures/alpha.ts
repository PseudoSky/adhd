// Fixture for orchestrator tests — "alpha" namespace.
// getUser is an unsafe action (safe: false by default → POST).
// The __samples__ key is NOT an exported API function and must be skipped.

export async function getUser(userId: string): Promise<{ id: string }> {
  return { id: userId }
}

export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
}
