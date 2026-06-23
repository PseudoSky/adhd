// Fixture for orchestrator tests — "beta" namespace.
// sendEmail is a distinct function from alpha.ts — should merge without collision.

export async function sendEmail(to: string, subject: string): Promise<void> {}

export const __samples__: Record<string, Record<string, unknown>> = {
  sendEmail: { to: 'a@b.com', subject: 'hi' },
}
