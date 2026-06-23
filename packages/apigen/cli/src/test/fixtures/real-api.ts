// Behavioral-regression fixture (dod.1 / dod.2 / dod.5 / dod.cli).
//
// Drives the full CLI pipeline end-to-end: every exported function becomes an
// MCP tool / HTTP route / CLI subcommand, named by its exported symbol. The
// `__samples__` map (per [conv:fixture-samples]) is the single source of truth
// the probe derives both the expected tool set AND the ground-truth values from
// — nothing is baked into a test literal.
//
// `getUser` / `listUsers` carry a first param named `ctx` to exercise the
// [inv:ctx-name-only] exclusion: `ctx` must NOT appear in any generated schema,
// and the in-process ground truth omits it.

export async function getUser(ctx: unknown, userId: string): Promise<{ id: string }> {
  return { id: userId }
}

export async function listUsers(ctx: unknown): Promise<string[]> {
  return ['alice', 'bob']
}

export async function createUser(name: string, role: string): Promise<{ name: string; role: string }> {
  return { name, role }
}

export function ping(): string {
  return 'pong'
}

export async function sendEmail(to: string, subject: string): Promise<{ to: string; subject: string; sent: boolean }> {
  return { to, subject, sent: true }
}

// __samples__ — the argument object the probe sends as the MCP `data` payload
// (and spreads positionally in-process, in dataParamNames order, ctx omitted).
export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
  listUsers: {},
  createUser: { name: 'Bob', role: 'admin' },
  ping: {},
  sendEmail: { to: 'a@b.com', subject: 'hi' },
}
