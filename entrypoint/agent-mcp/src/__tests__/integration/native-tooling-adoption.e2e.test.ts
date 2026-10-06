/**
 * native-tooling-adoption.e2e.test.ts — NAT-TOOL-8 (ADR-0008 D7).
 *
 * ── HUMAN-GATED ADOPTION — APPROVED ─────────────────────────────────────────
 * The upstream MCP-server adoption in ADR-0008 D7 is a human-gated decision.
 * It is APPROVED and recorded here (this header), in this package's `README.md`
 * ("Native-tooling adoption gate") and its `AGENTS.md` — the three places
 * AGENTS.md §7 / ADR-0008 D7 require.
 *
 *   Approved by:  pseudosky (repo owner)
 *   Date:         2026-10-05
 *   Directive:    "Finish the project"
 *   Gate reason:  this test drives the REAL external third-party MCP server
 *                 `tumf/mcp-shell-server` (uvx fetches it from PyPI at run time)
 *                 wrapped by `@anthropic-ai/sandbox-runtime` (`srt`) — an outside
 *                 system CI cannot provide hermetically. That is the sole gate
 *                 reason AGENTS.md §7 permits (an external third-party service).
 *   Adopted set:  `@modelcontextprotocol/server-filesystem` (fs),
 *                 `tumf/mcp-shell-server` (shell; allowlisted argv, never a
 *                 shell string), `@anthropic-ai/sandbox-runtime` (`srt`, wraps
 *                 both). `unbash` DROPPED; `rust-mcp-filesystem` deferred.
 *
 * What it proves (AC2): a server RESOLVED by `resolveNativeTooling`
 * (`@adhd/agent-core-native-tooling`) — the adopted, `srt`-wrapped
 * `tumf/mcp-shell-server` — starts, HANDSHAKES through the real
 * `agent_verify_mcp` implementation, and EXECUTES an allowlisted argv command;
 * and that the `ALLOW_PATTERNS` passthrough (ADR-0008 D5 "free win": enable the
 * adopted server's pattern allow-list, `re.fullmatch` over the command NAME)
 * is enforced by the REAL server — a matching NAME runs, a non-matching NAME is
 * denied. The default (unflagged) pattern proof lives in
 * `native-tooling-pattern-allowlist.e2e.test.ts`.
 *
 * Run: `NAT_TOOL_LIVE=1 npx nx test agent-mcp -- native-tooling-adoption`
 * ────────────────────────────────────────────────────────────────────────────
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  StdioMcpClient,
  verifyAgentMcpServers,
} from '@adhd/agent-engine-orchestrator';
import type {
  AgentDefinition,
  McpServerConfig,
} from '@adhd/agent-engine-orchestrator';
import { resolveNativeTooling } from '@adhd/agent-core-native-tooling';

import { provisionSrtPolicy } from '../../srt-policy.js';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;

/** Gate: the real adopted server is fetched from PyPI by `uvx` (external). */
const isLive = process.env['NAT_TOOL_LIVE'] === '1';

/** Repo root — `entrypoint/agent-mcp/src/__tests__/integration/` → five levels up. */
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

const BIN_DIR = join(REPO_ROOT, 'node_modules', '.bin');
const UV_CACHE = join(homedir(), '.cache', 'uv');

/** A real, allowlisted `echo <token>` argv — the command under test. */
const LIVE_TOKEN = 'nat-tool-8-live-ok';

function fakeAgentStore(mcpServers: AgentDefinition['mcpServers']) {
  return {
    read: (name: string): AgentDefinition =>
      ({
        name,
        version: 1,
        provider: { type: 'claudecli' },
        mcpServers,
        permissions: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as AgentDefinition,
  };
}

/**
 * The `srt` policy that lets the wrapped server reach its own uv cache + PyPI —
 * provisioned through the host's own helper (deferral `a5a2f1d4`), which seeds
 * the PyPI + npm allow-list by default.
 */
function srtSettings(home: string, workdir: string): void {
  provisionSrtPolicy({
    settingsPath: join(home, '.srt-settings.json'),
    allowWrite: [home, workdir, UV_CACHE],
  });
}

describe.skipIf(!isLive)(
  'native tooling adoption — resolved shell server via agent_verify_mcp (NAT_TOOL_LIVE=1 only)',
  () => {
    let home = '';
    let workdir = '';
    let originalPath = '';

    beforeAll(async () => {
      // A hermetic HOME holding the `srt` policy (srt reads `~/.srt-settings.json`),
      // and a scratch cwd — both under the gitignored repo `tmp/`.
      const scratchRoot = join(REPO_ROOT, 'tmp', 'agent-mcp');
      await mkdir(scratchRoot, { recursive: true });
      workdir = await mkdtemp(join(scratchRoot, 'nat-tool-8-'));
      home = join(workdir, 'home');
      await mkdir(home, { recursive: true });
      srtSettings(home, workdir);
      // The host owns PATH: the `srt` bin is a local dependency bin, not globally
      // installed, so make it resolvable for the spawned child (and its `uvx`).
      originalPath = process.env['PATH'] ?? '';
      process.env['PATH'] = `${BIN_DIR}${delimiter}${originalPath}`;
    });

    afterAll(async () => {
      if (originalPath) process.env['PATH'] = originalPath;
      if (workdir) await rm(workdir, { recursive: true, force: true });
    });

    it('starts, handshakes (agent_verify_mcp) and runs an allowlisted argv command', async () => {
      const servers = resolveNativeTooling(
        { fs: false, shell: { allowCommands: ['echo', 'pwd', 'ls'] }, dispatch: false },
        {
          cwd: workdir,
          env: { HOME: home, UV_CACHE_DIR: UV_CACHE, PATH: process.env['PATH'] ?? '' },
        }
      );
      const shell = servers.find((s): s is Stdio => s.transport === 'stdio');
      if (!shell) throw new Error('a stdio shell server must resolve');
      // D7: the builtin shell server is wrapped by the adopted `srt` sandbox.
      expect(shell.command).toBe('srt');
      expect(shell.args).toEqual(['uvx', 'mcp-shell-server']);
      // D5/D7: the argv allowlist is a passthrough of the adopted server's env.
      expect(shell.env?.ALLOW_COMMANDS).toBe('echo,pwd,ls');

      // 1) HANDSHAKE — the real `agent_verify_mcp` implementation.
      const verified = await verifyAgentMcpServers(
        { name: 'native-tooling-adoption' },
        { agentStore: fakeAgentStore({ shell }) }
      );
      const shellResult = verified.servers.find((s) => s.name === 'shell');
      expect(shellResult?.status, shellResult?.error).toBe('verified');
      expect(shellResult?.tools).toContain('shell_execute');

      // 2) EXECUTE — an allowlisted argv command (never a shell string).
      const client = new StdioMcpClient('shell', shell);
      await client.connect();
      try {
        const output = await client.callTool('shell_execute', {
          command: ['echo', LIVE_TOKEN],
        });
        expect(JSON.stringify(output)).toContain(LIVE_TOKEN);
      } finally {
        await client.close();
      }
    }, 180_000);

    it('passes ALLOW_PATTERNS through and the REAL server executes a matching NAME, denies a non-matching NAME', async () => {
      const servers = resolveNativeTooling(
        { fs: false, shell: { allowPatterns: ['ec.*'] }, dispatch: false },
        {
          cwd: workdir,
          env: { HOME: home, UV_CACHE_DIR: UV_CACHE, PATH: process.env['PATH'] ?? '' },
        }
      );
      const shell = servers.find((s): s is Stdio => s.transport === 'stdio');
      if (!shell) throw new Error('a stdio shell server must resolve');
      expect(shell.command).toBe('srt');
      expect(shell.args).toEqual(['uvx', 'mcp-shell-server']);
      // D5/D7: the pattern allow-list is a passthrough of the adopted server's
      // env — no exact names here, ONLY the regex.
      expect(shell.env?.ALLOW_PATTERNS).toBe('ec.*');
      expect(shell.env?.ALLOW_COMMANDS).toBeUndefined();

      // 1) HANDSHAKE — the real `agent_verify_mcp` implementation.
      const verified = await verifyAgentMcpServers(
        { name: 'native-tooling-pattern-adoption' },
        { agentStore: fakeAgentStore({ shell }) }
      );
      const shellResult = verified.servers.find((s) => s.name === 'shell');
      expect(shellResult?.status, shellResult?.error).toBe('verified');
      expect(shellResult?.tools).toContain('shell_execute');

      // 2) EXECUTE — `echo` fully matches `ec.*`, so the real server runs it.
      const client = new StdioMcpClient('shell', shell);
      await client.connect();
      try {
        const output = await client.callTool('shell_execute', {
          command: ['echo', LIVE_TOKEN],
        });
        expect(JSON.stringify(output)).toContain(LIVE_TOKEN);

        // 3) DENY — `frobnicate` matches no pattern → the real server refuses.
        await expect(
          client.callTool('shell_execute', { command: ['frobnicate', '--x'] })
        ).rejects.toThrow(/not allowed|rejected/i);
      } finally {
        await client.close();
      }
    }, 180_000);
  }
);
