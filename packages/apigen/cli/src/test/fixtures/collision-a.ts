// Fixture for collision-check test — same-namespace file pair.
// When combined with collision-b.ts under the same namespace, the exported
// function name "ping" will appear twice and trigger a collision.

export async function ping(): Promise<string> {
  return 'pong-a'
}
