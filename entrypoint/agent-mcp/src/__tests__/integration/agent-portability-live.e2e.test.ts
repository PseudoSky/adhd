/**
 * agent-portability-live.e2e.test.ts — dispatch-2026-10-06-48dc, 48dc-PORT AC2.
 *
 * ── ENV-GATED (paid third-party model) — APPROVED ───────────────────────────
 * Gate: NAT_TOOL_LIVE=1. Qualifying reason (AGENTS.md §7, the ONLY one): this
 * leg calls a REAL paid LLM (DeepSeek, `ADHD_AGENT_DEEPSEEK_SECRET` from
 * `~/.adhd/.env`). Approved by: pseudosky (repo owner), under the 2026-10-06
 * dispatch-2026-10-06-48dc cost cap of $0.05 total (one task, `maxTokens: 400`,
 * `ADHD_AGENT_BUDGET_MAX_CALLS=8`). The same gate is already recorded for the
 * sibling native-tooling live tests in this package's `README.md` and
 * `AGENTS.md` (NAT_TOOL_LIVE table); this header is the third required place.
 * With the gate ON, a missing secret / dist / npx / uvx FAILS LOUDLY.
 *
 * What it proves: a REAL model, driving the REAL built agent-mcp over MCP stdio
 * from a caller cwd outside the repo (containing a space), actually executes the
 * native fs + shell tools in that cwd. Assertions are model-independent: bytes
 * on disk (the file the model was told to write, and a marker created by the
 * allowlisted shell `touch` in the caller cwd) — never the model's prose.
 *
 * Run: `NAT_TOOL_LIVE=1 npx vitest run --config vite.config.ts \
 *         src/__tests__/integration/agent-portability-live.e2e.test.ts`
 * ────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPortabilityHost, type PortabilityHost } from './portability-host.js';

const isLive = process.env['NAT_TOOL_LIVE'] === '1';
const real = (p: string) => fs.realpathSync(p);

const SECRET_NAME = 'ADHD_AGENT_DEEPSEEK_SECRET';

function deepseekSecretPresent(): boolean {
  if (process.env['ADHD_AGENT_DEEPSEEK_SECRET']) return true;
  try {
    const line = fs
      .readFileSync(path.join(os.homedir(), '.adhd', '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(SECRET_NAME + '='));
    return line !== undefined && line.length > SECRET_NAME.length + 1;
  } catch {
    return false;
  }
}

describe.skipIf(!isLive)(
  '48dc-PORT AC2 real model (DeepSeek) executes native fs+shell in the caller cwd (NAT_TOOL_LIVE=1 only)',
  () => {
    let scratch = '';
    let cwd = '';
    let host: PortabilityHost;

    beforeAll(async () => {
      expect(deepseekSecretPresent(), 'ADHD_AGENT_DEEPSEEK_SECRET must be set (env or ~/.adhd/.env)').toBe(true);
      scratch = real(fs.mkdtempSync(path.join(os.tmpdir(), 'portability-48dc-live-')));
      cwd = path.join(scratch, 'caller dir');
      fs.mkdirSync(cwd, { recursive: true });
      cwd = real(cwd);
      const serverCwd = path.join(scratch, 'server-cwd');
      fs.mkdirSync(serverCwd);
      host = await startPortabilityHost({
        serverCwd,
        scratch,
        keepAmbientAgentEnv: true,
        env: { ADHD_AGENT_BUDGET_MAX_CALLS: '8' },
      });
      const created = await host.callJson('agent_create', {
        name: 'port-live',
        provider: {
          type: 'openai',
          model: 'deepseek-chat',
          baseURL: 'https://api.deepseek.com/v1',
          env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
          maxTokens: 400,
        },
        systemPrompt:
          'You are a terse tool-using agent. Use the provided tools exactly as instructed, then reply DONE.',
        nativeTooling: { fs: true, shell: { allowCommands: ['touch'] }, dispatch: false },
      });
      expect(created['_isError'], JSON.stringify(created)).toBeUndefined();
    }, 120_000);

    afterAll(async () => {
      await host?.close();
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('48dc-PORT AC2: real model writes a file via fs and touches a marker via shell, both in the caller cwd', async () => {
      const token = `LIVE-${Date.now()}`;
      const target = path.join(cwd, 'live.txt');
      const out = await host.callJson('task', {
        agent_name: 'port-live',
        cwd,
        prompt:
          `Do exactly two things. 1) With the fs write_file tool, write the text ${token} to the file ${target}. ` +
          `2) With the shell shell_execute tool, run the command ["touch","live-marker.txt"]. Then reply DONE.`,
      });
      expect(out['status'], JSON.stringify(out)).toBe('completed');
      expect(fs.readFileSync(target, 'utf8')).toContain(token);
      expect(fs.existsSync(path.join(cwd, 'live-marker.txt'))).toBe(true);
    }, 300_000);
  }
);
