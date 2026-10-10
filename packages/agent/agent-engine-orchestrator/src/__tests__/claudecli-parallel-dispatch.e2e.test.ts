/**
 * claudecli-parallel-dispatch.e2e.test.ts — 424b6362 (R3-PAR-B): does the real `claude` CLI run two
 * same-message MCP tool calls concurrently through the claudecli loopback bridge, with and without
 * `annotations:{readOnlyHint:true}` advertised in ListTools?
 *
 * Real components: the real `startToolBridge` (bound 127.0.0.1 port) and the real `claude` binary
 * (model claude-haiku-4-5, tiny prompt). The bridged `slow` tool is a latch: each call records its
 * start, then waits for the OTHER call to start (bounded deadline) before finishing. Overlap is
 * decided from the latch, not from sleeps. A missing `claude` binary FAILS the test (live-testing
 * rule), it never skips. This is a paid third-party model, but it is NOT env-gated: each run is a
 * couple of haiku turns.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startToolBridge, buildBridgeMcpConfig } from '../providers/claudecli-tool-bridge.js';
import type { EngineLogger } from '../interfaces.js';

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const LATCH_DEADLINE_MS = 8_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface CallRecord { id: string; startedAt: number; endedAt: number; sawPeer: boolean }
interface Observation {
  calls: CallRecord[];
  /** Both tool_use blocks arrived in ONE assistant message (so serialisation is the CLI's, not the model's). */
  sameMessage: boolean;
  overlapped: boolean;
  advertisedAnnotations: unknown;
}

async function observe(withReadOnlyHint: boolean): Promise<Observation> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adhd-par-')));
  dirs.push(dir);
  const calls: CallRecord[] = [];
  const started = new Map<string, () => void>();
  const peerStarted = new Map<string, Promise<void>>();
  for (const id of ['a', 'b']) peerStarted.set(id, new Promise<void>((r) => started.set(id, r)));

  const bridge = await startToolBridge({
    tools: [{
      name: 'spike__slow',
      description: 'Latch test tool. Pass id "a" or "b".',
      inputSchema: { type: 'object', properties: { id: { type: 'string', enum: ['a', 'b'] } }, required: ['id'] },
    }],
    logger,
    callTimeoutMs: LATCH_DEADLINE_MS + 10_000,
    toolAnnotations: withReadOnlyHint ? () => ({ readOnlyHint: true }) : undefined,
    executeTool: async (_server, _tool, args) => {
      const id = String((args as { id?: unknown }).id);
      const startedAt = Date.now();
      started.get(id)?.();
      const peer = peerStarted.get(id === 'a' ? 'b' : 'a');
      let sawPeer = false;
      if (peer) {
        let t: NodeJS.Timeout | undefined;
        sawPeer = await Promise.race([
          peer.then(() => true),
          new Promise<boolean>((r) => { t = setTimeout(() => r(false), LATCH_DEADLINE_MS); }),
        ]);
        if (t) clearTimeout(t);
      }
      calls.push({ id, startedAt, endedAt: Date.now(), sawPeer });
      return { result: `done ${id}`, isError: false };
    },
  });
  try {
    const cfg = join(dir, 'mcp.json');
    writeFileSync(cfg, JSON.stringify(buildBridgeMcpConfig(bridge)));
    const args = [
      '-p', 'Call the mcp__spike__slow tool twice IN THE SAME MESSAGE as two parallel tool calls: id "a" and id "b". Then reply "ok".',
      '--model', 'claude-haiku-4-5',
      '--strict-mcp-config', '--mcp-config', cfg,
      '--allowedTools', 'mcp__spike__slow',
      '--tools', '',
      '--max-turns', '4',
      '--output-format', 'stream-json', '--verbose',
    ];
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      child.on('error', reject);
      child.on('close', () => resolve({ stdout: out }));
    });
    // stream-json emits one `assistant` event PER content block, all sharing the API message id;
    // two tool_use blocks under one message id == the model issued them in the same message.
    const usesByMessage = new Map<string, number>();
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; message?: { id?: string; content?: Array<{ type?: string; name?: string }> } };
        if (ev.type === 'assistant') {
          const n = (ev.message?.content ?? []).filter((b) => b.type === 'tool_use' && b.name === 'mcp__spike__slow').length;
          if (n > 0) usesByMessage.set(ev.message?.id ?? '?', (usesByMessage.get(ev.message?.id ?? '?') ?? 0) + n);
        }
      } catch { /* non-JSON line */ }
    }
    const sameMessage = [...usesByMessage.values()].some((n) => n >= 2);
    calls.sort((x, y) => x.startedAt - y.startedAt);
    const overlapped = calls.length === 2 && calls.every((c) => c.sawPeer);
    return { calls, sameMessage, overlapped, advertisedAnnotations: withReadOnlyHint ? { readOnlyHint: true } : undefined };
  } finally {
    await bridge.close();
  }
}

describe('424b6362 R3-PAR-B parallel dispatch through the real claude CLI', () => {
  it('424b6362 AC1: claude binary is present (fails, never skips)', () => {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    expect(r.status, 'claude CLI must be installed to run this suite').toBe(0);
  });

  it('424b6362 AC1 spike: record overlap with and without readOnlyHint', { timeout: 240_000 }, async () => {
    const without = await observe(false);
    const withHint = await observe(true);
    // eslint-disable-next-line no-console
    console.log('PAR-B-SPIKE', JSON.stringify({ without, withHint }, null, 1));
    for (const o of [without, withHint]) {
      expect(o.calls.length).toBe(2);
      // The finding is only meaningful when the model really issued both calls in ONE message.
      expect(o.sameMessage, 'model must issue both calls in one assistant message').toBe(true);
    }
    // Recorded finding (424b6362, claude 2.1.296, haiku-4-5): the CLI serialises same-message calls
    // to a server whose tools carry no readOnlyHint, and runs them concurrently when they do.
    expect(without.overlapped, 'CLI now overlaps un-annotated MCP calls: revisit 424b6362').toBe(false);
    expect(withHint.overlapped, 'CLI no longer overlaps readOnlyHint MCP calls: revisit 424b6362').toBe(true);
  });
});
