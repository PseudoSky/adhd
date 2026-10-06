/**
 * native-tooling-pattern-allowlist.test.ts — the shell `allowPatterns`
 * passthrough (ADR-0008 D5/D7 "Free win": enable the adopted server's
 * `ALLOW_PATTERNS`). SPEC §AC1/AC2/AC3.
 *
 * What it proves, DEFAULT-RUNNING (no external fetch, no env gate):
 *   AC1 — `shell:{allowPatterns:[…]}` resolves to a shell server whose env
 *          carries `ALLOW_PATTERNS` with those values (via the REAL
 *          `resolveNativeTooling`), and the keyed projection carries it too.
 *   AC2 — driven through the REAL stdio MCP client (`StdioMcpClient`, real
 *          JSON-RPC over a spawned child), a command whose NAME matches a
 *          pattern EXECUTES and a non-matching NAME is DENIED by the server.
 *   AC3 — exact `allowCommands` still works unchanged and COMBINES with
 *          `allowPatterns` (the adopted server ORs the two).
 *
 * The adopted server `tumf/mcp-shell-server` is an EXTERNAL third-party service
 * (`uvx` fetches it from PyPI); its documented `ALLOW_PATTERNS` decision
 * (`re.fullmatch(pattern, command[0])` OR an exact `ALLOW_COMMANDS` name) is
 * exercised against the real server in the gated
 * `native-tooling-adoption.e2e.test.ts` (NAT_TOOL_LIVE=1). This suite stubs only
 * that external boundary with a faithful local fixture so the wiring has teeth
 * in CI. The HARNESS under test parses nothing — it plumbs env through (D5).
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveNativeTooling } from '@adhd/agent-core-native-tooling';
import { StdioMcpClient } from '@adhd/agent-engine-orchestrator';
import type { McpServerConfig, ShellToolConfig } from '@adhd/agent-base-types';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;

/** The faithful stand-in for the adopted external shell server. */
const FIXTURE = fileURLToPath(
  new URL('../fixtures/shell-pattern-allowlist-server.mjs', import.meta.url)
);

/**
 * Resolve the shell server through the REAL resolver (sandbox off so we can
 * spawn the fixture directly) and return its emitted env.
 */
function resolvedShellEnv(shell: ShellToolConfig): Record<string, string> {
  const servers = resolveNativeTooling(
    { fs: false, shell, dispatch: false },
    { cwd: process.cwd(), sandbox: false }
  );
  const resolved = servers.find((s): s is Stdio => s.transport === 'stdio');
  if (!resolved) throw new Error('a stdio shell server must resolve');
  return resolved.env ?? {};
}

/** Spawn the fixture with the given env and invoke `shell_execute`. */
async function runShell(
  env: Record<string, string>,
  command: string[]
): Promise<unknown> {
  const client = new StdioMcpClient('shell', {
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env,
  });
  await client.connect();
  try {
    return await client.callTool('shell_execute', { command });
  } finally {
    await client.close();
  }
}

describe('shell allowPatterns passthrough — resolver + real spawned server (ADR-0008 D5/D7)', () => {
  it('AC1: allowPatterns resolves into ALLOW_PATTERNS on the mounted shell server', () => {
    const env = resolvedShellEnv({ allowPatterns: ['ls.*', 'git'] });
    expect(env.ALLOW_PATTERNS).toBe('ls.*,git');
  });

  it('AC2: a NAME matching a pattern executes; a non-matching NAME is denied', async () => {
    const env = resolvedShellEnv({ allowPatterns: ['ls.*', 'git'] });
    // Matching NAME (`ls` fully matches `ls.*`) → the server runs it.
    const ok = await runShell(env, ['ls', '-la']);
    expect(JSON.stringify(ok)).toContain('ran:ls -la');
    // Non-matching NAME → the server refuses with a typed error.
    await expect(runShell(env, ['frobnicate', '--rm'])).rejects.toThrow(/not allowed/i);
  });

  it('AC3: exact allowCommands still works and COMBINES with allowPatterns', async () => {
    const env = resolvedShellEnv({ allowCommands: ['pwd'], allowPatterns: ['ls.*'] });
    expect(env.ALLOW_COMMANDS).toBe('pwd');
    expect(env.ALLOW_PATTERNS).toBe('ls.*');
    // Exact name (unchanged behavior) …
    expect(JSON.stringify(await runShell(env, ['pwd']))).toContain('ran:pwd');
    // … and the pattern, side by side.
    expect(JSON.stringify(await runShell(env, ['ls']))).toContain('ran:ls');
    // A NAME in neither list is denied.
    await expect(runShell(env, ['echo', 'hi'])).rejects.toThrow(/not allowed/i);
  });

  it('AC-NC: with no allowPatterns emission there is no ALLOW_PATTERNS, and the matching NAME is DENIED', async () => {
    // This is the exact observable a dropped `allowPatterns` emission produces:
    // a config declaring patterns but emitting none resolves to a server with no
    // ALLOW_PATTERNS — so a previously-allowed NAME now fails. Turning the
    // emission back on is what makes the `ls` call above succeed.
    const env = resolvedShellEnv({ allowPatterns: [] });
    expect(env.ALLOW_PATTERNS).toBeUndefined();
    await expect(runShell(env, ['ls', '-la'])).rejects.toThrow(/not allowed/i);
  });
});
