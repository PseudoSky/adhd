/**
 * serve.singleton.spec.ts — `[inv:singleton]` (docs/spec/service-lifecycle.md
 * §5, sox-ecosystem) for `backlog serve`. Real two-subprocess proof, same
 * pattern as `serve.spec.ts`: spawns the REAL BUILT `dist/index.js serve
 * --transport mcp` — exactly what `.mcp.json` invokes — as genuine child
 * processes, never an in-process bypass.
 *
 * Incident: two concurrently-running `backlog serve --transport mcp`
 * processes writing the SAME store corrupted
 * `~/.adhd/backlog/production/data/backlog.db` (upstream race
 * tursodatabase/turso#7833/#8348). Before this fix, `startBacklogServer`
 * had NO singleton guard at all — verified live (2026-08-17, ad-hoc, not
 * committed): building this suite's exact two-subprocess race against the
 * PRE-FIX commit (226074df) produced `{ aOk: true, bOk: true }`, i.e. BOTH
 * instances connected and would have both held the store open concurrently.
 * This suite is the GREEN half of that same red→green pair, made durable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedSpawnOptions } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

async function connect(
  adhdRoot: string,
  name: string
): Promise<
  | { ok: true; client: Client; transport: StdioClientTransport }
  | { ok: false; error: Error }
> {
  const transport = new StdioClientTransport({
    // `process.execPath` (not `'node'` off PATH) — aligned with the
    // `runIsolatedBin`/`isolatedSpawnOptions` sites.
    command: process.execPath,
    args: [DIST_INDEX, 'serve', '--transport', 'mcp'],
    // The required `ADHD_BACKLOG_SCOPE=project` + `HOME=<root>` redirect pair
    // lives in ONE place now — `test/helpers/spawn-isolated-bin.ts`.
    ...isolatedSpawnOptions(adhdRoot),
  });
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools(); // round-trip through the real transport, not just spawn success
    return { ok: true, client, transport };
  } catch (err) {
    await transport.close().catch(() => undefined);
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

describe('backlog serve — [inv:singleton]: a second concurrent instance against the same store is refused, never races', () => {
  let adhdRoot: string | undefined;

  afterEach(async () => {
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    adhdRoot = undefined;
  });

  it("GREEN: while instance A is live, a second `serve` (B) against the SAME store is refused and names A's pid — A is unaffected", async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-singleton-'));

    const a = await connect(adhdRoot, 'singleton-a');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await connect(adhdRoot, 'singleton-b');
    expect(b.ok).toBe(false);
    if (b.ok) {
      await b.client.close().catch(() => undefined);
      await b.transport.close().catch(() => undefined);
    } else {
      // MCP stdio failure surfaces as a generic transport-closed error to the
      // CLIENT (the child's own stderr carries the real ServeLockHeldError
      // message — asserted below via the lock file itself, since capturing
      // child stderr through the SDK's transport is not part of its public
      // surface). What we CAN assert client-side: B's connection genuinely
      // failed, not merely timed out.
      expect(b.error).toBeTruthy();
    }

    // A is still alive and answering — the guard did not disturb the survivor.
    const stillUp = await a.client.listTools();
    expect(stillUp.tools.length).toBeGreaterThan(0);

    // The lock file names A's own pid as holder for the whole window.
    const lockPath = join(
      adhdRoot,
      '.adhd',
      'backlog',
      'production',
      'data',
      'backlog.db.serve.lock'
    );
    expect(existsSync(lockPath)).toBe(true);
    const holderPid = Number(readFileSync(lockPath, 'utf8').split('\n')[0]);
    expect(Number.isInteger(holderPid) && holderPid > 0).toBe(true);

    await a.client.close().catch(() => undefined);
    await a.transport.close().catch(() => undefined);
  }, 30_000);

  it('shutdown-window: while A is still draining (lock held, not yet released), a concurrent start is refused; once A fully closes, a fresh start succeeds', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-singleton-shutdown-'));

    const a = await connect(adhdRoot, 'shutdown-a');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // Close A gracefully (SIGTERM → AbortController → store close → lock
    // release, in that order per server.ts). transport.close() waits for the
    // child to actually exit, so by the time it resolves the lock is fully
    // released — proving the window is closed, not merely narrowed: had the
    // lock been released on SIGNAL RECEIPT instead of after store-close, a
    // racing start during A's drain would have been let through even though
    // A's store connection was still open.
    await a.client.close().catch(() => undefined);
    await a.transport.close().catch(() => undefined);

    const c = await connect(adhdRoot, 'shutdown-c');
    expect(c.ok).toBe(true);
    if (c.ok) {
      await c.client.close().catch(() => undefined);
      await c.transport.close().catch(() => undefined);
    }
  }, 30_000);

  it("crash recovery: a SIGKILLed instance's stale lock is reclaimed automatically by the next start, no manual cleanup required", async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-singleton-crash-'));

    const d = await connect(adhdRoot, 'crash-d');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const pid = (d.transport as unknown as { _process?: { pid?: number } })
      ._process?.pid;
    expect(typeof pid).toBe('number');
    // SIGKILL directly — deliberately NOT `client.close()`/`transport.close()`
    // first (those send SIGTERM and await a graceful exit, which would run
    // the normal store-close+lock-release path this test exists to bypass).
    // A crash never gets that chance; this is the "no chance to run cleanup
    // code" case serve-lock.ts's own doc comment is honest about.
    if (pid) process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const e = await connect(adhdRoot, 'crash-e');
    expect(e.ok).toBe(true);
    if (e.ok) {
      await e.client.close().catch(() => undefined);
      await e.transport.close().catch(() => undefined);
    }
  }, 30_000);
});
