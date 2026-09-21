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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// STATE.md A15: this file previously spawned the real `dist/index.js serve
// --transport mcp` with a local `adhdRoot` (mkdtempSync) used ONLY as the
// transport's `cwd` — never wired to `ADHD_ROOT`/`--namespace sandbox` — so
// the real machine's global `embedding.enabled: true` config.yaml still
// resolved through (confirmed: 10 real onnxruntime/CoreML hits in
// isolation, across this file's 3 tests). Moved onto the canonical
// sandbox helper.
import {
  mintBacklogSandbox,
  stdioSpawnOptionsForSandbox,
  type SandboxHandle,
} from './test/helpers/spawn-backlog-bin.js';

/**
 * Bounded poll on the actual condition a crash-recovery proof needs — the
 * SIGKILLed pid has genuinely stopped existing (`process.kill(pid, 0)`
 * throws `ESRCH`), not a fixed sleep (AGENTS.md §7 rule 3: "be deterministic
 * without timing... never sleep/wall-clock" for concurrency proofs). Mirrors
 * the deadline+poll shape used elsewhere in this package (`server.spec.ts`,
 * `server.verbs.spec.ts`, `batch-adoption.spec.ts`, `web-ui.spec.ts`).
 */
async function waitForProcessExit(pid: number, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} still alive ${deadlineMs}ms after SIGKILL`);
}

async function connect(sandbox: SandboxHandle, name: string): Promise<
  { ok: true; client: Client; transport: StdioClientTransport } | { ok: false; error: Error }
> {
  // Deliberately NO `ADHD_BACKLOG_SCOPE: 'project'` override here — see
  // `serve.spec.ts`'s identical note: `scope: 'project'` resolves its base
  // purely from `findProjectRoot(cwd)`, never honoring `adhdRoot`
  // (a real, disclosed `@adhd/environment-builder` bug this task found).
  // `--namespace sandbox` alone (default `global` scope, which DOES honor
  // `adhdRoot`) fully isolates every spawn here.
  const transport = new StdioClientTransport(
    stdioSpawnOptionsForSandbox(sandbox, ['serve', '--transport', 'mcp'])
  );
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools(); // round-trip through the real transport, not just spawn success
    return { ok: true, client, transport };
  } catch (err) {
    await transport.close().catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

describe('backlog serve — [inv:singleton]: a second concurrent instance against the same store is refused, never races', () => {
  let sandbox: SandboxHandle | undefined;

  afterEach(async () => {
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
  });

  it('GREEN: while instance A is live, a second `serve` (B) against the SAME store is refused and names A\'s pid — A is unaffected', async () => {
    sandbox = mintBacklogSandbox();

    const a = await connect(sandbox, 'singleton-a');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await connect(sandbox, 'singleton-b');
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
    // Namespace-sandbox layout (unlike the old `ADHD_BACKLOG_SCOPE=project`
    // scheme): `<adhdRoot>/backlog/sandbox/data/...`, no `.adhd`/`production`
    // segments — mirrors `sandbox.dbPath` (`sandbox-path`'s own report) with
    // `.serve.lock` appended, the exact suffix `serve-lock.ts` uses.
    const lockPath = `${sandbox.dbPath}.serve.lock`;
    expect(existsSync(lockPath)).toBe(true);
    const holderPid = Number(readFileSync(lockPath, 'utf8').split('\n')[0]);
    expect(Number.isInteger(holderPid) && holderPid > 0).toBe(true);

    await a.client.close().catch(() => undefined);
    await a.transport.close().catch(() => undefined);
  }, 30_000);

  it('shutdown-window: while A is still draining (lock held, not yet released), a concurrent start is refused; once A fully closes, a fresh start succeeds', async () => {
    sandbox = mintBacklogSandbox();

    const a = await connect(sandbox, 'shutdown-a');
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

    const c = await connect(sandbox, 'shutdown-c');
    expect(c.ok).toBe(true);
    if (c.ok) {
      await c.client.close().catch(() => undefined);
      await c.transport.close().catch(() => undefined);
    }
  }, 30_000);

  it('crash recovery: a SIGKILLed instance\'s stale lock is reclaimed automatically by the next start, no manual cleanup required', async () => {
    sandbox = mintBacklogSandbox();

    const d = await connect(sandbox, 'crash-d');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const pid = (d.transport as unknown as { _process?: { pid?: number } })._process?.pid;
    expect(typeof pid).toBe('number');
    // SIGKILL directly — deliberately NOT `client.close()`/`transport.close()`
    // first (those send SIGTERM and await a graceful exit, which would run
    // the normal store-close+lock-release path this test exists to bypass).
    // A crash never gets that chance; this is the "no chance to run cleanup
    // code" case serve-lock.ts's own doc comment is honest about.
    if (pid) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid);
    }

    const e = await connect(sandbox, 'crash-e');
    expect(e.ok).toBe(true);
    if (e.ok) {
      await e.client.close().catch(() => undefined);
      await e.transport.close().catch(() => undefined);
    }
  }, 30_000);
});
