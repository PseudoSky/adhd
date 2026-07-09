/**
 * registry-connect-retry.test.ts
 *
 * Guards two defects in `McpClientRegistry.getOrCreateClient` (BACKLOG BUG-ORCH-001,
 * BUG-ORCH-002), both in the same block:
 *
 *   1. BUG-ORCH-001 — `let client` and a later `const client` collided in one block
 *      scope (`TS2451: Cannot redeclare block-scoped variable 'client'`), so the
 *      package did not compile and `nx build agent-mcp` was red through 19 dependent
 *      tasks. The build is that bug's regression guard; this file guards the BEHAVIOUR
 *      of the code that was rewritten to fix it.
 *
 *   2. BUG-ORCH-002 — a REJECTED connect promise stayed cached in `connectPromises`
 *      forever (the map was only ever cleared wholesale in `close()`). Every later
 *      `getClient(name)` re-awaited that same rejected promise and rethrew the
 *      original error, so a server that failed to connect ONCE could never reconnect
 *      for the life of the process — no retry, no recovery.
 *
 * These drive the REAL `McpClientRegistry` over a REAL `StdioClientTransport`, which
 * really spawns the configured command. Nothing about the unit under test is mocked.
 *
 * TEETH: the retry test counts actual process spawns via a file the spawned command
 * appends to. With BUG-ORCH-002 present the count stays at 1 (the cached rejection is
 * rethrown without a new spawn); with it fixed the count reaches 2. It cannot pass
 * vacuously. Determinism comes from the spawned process exiting immediately — there is
 * no sleep and no wall-clock dependency anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientRegistry } from '../clients/registry.js';
import type { ExecutionContext } from '../validation/index.js';
import type { InProcessToolHandler } from '../clients/in-process.js';

const ctx = {} as ExecutionContext;
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;

/** Count the lines the spawned command appended — i.e. how many times it really ran. */
function spawnCount(marker: string): number {
  if (!existsSync(marker)) return 0;
  return readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
}

describe('McpClientRegistry — connect failure must not poison the client cache', () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhd-registry-test-'));
    marker = join(dir, 'spawns.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A server whose command really spawns, records the attempt, then dies. */
  function failingRegistry(): McpClientRegistry {
    return new McpClientRegistry(
      {
        flaky: {
          transport: 'stdio',
          command: 'sh',
          // Record the spawn, then exit non-zero WITHOUT speaking MCP -> connect rejects.
          args: ['-c', `echo attempt >> ${marker}; exit 1`],
        },
      } as never,
      undefined,
      [],
      noopHandler,
      ctx,
    );
  }

  it('rejects when the MCP server process fails to connect', async () => {
    const registry = failingRegistry();
    await expect(registry.getClient('flaky')).rejects.toThrow();
    expect(spawnCount(marker)).toBe(1);
  });

  it('BUG-ORCH-002: a second call RETRIES instead of rethrowing a cached rejection', async () => {
    const registry = failingRegistry();

    await expect(registry.getClient('flaky')).rejects.toThrow();
    expect(spawnCount(marker)).toBe(1);

    // With the bug, this rethrows the *cached* rejected promise and never spawns again.
    await expect(registry.getClient('flaky')).rejects.toThrow();

    // The assertion with teeth: a real second spawn happened.
    expect(spawnCount(marker)).toBe(2);
  });

  it('concurrent callers share ONE connect attempt (no duplicate spawn)', async () => {
    const registry = failingRegistry();

    // Both calls are issued before any await resolves, so they must dedupe through
    // `connectPromises` rather than each spawning their own subprocess.
    const [a, b] = await Promise.allSettled([registry.getClient('flaky'), registry.getClient('flaky')]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(spawnCount(marker)).toBe(1);
  });

  it('an unknown server name fails fast and never spawns', async () => {
    const registry = failingRegistry();
    await expect(registry.getClient('does-not-exist')).rejects.toThrow(/No MCP server config found/);
    expect(spawnCount(marker)).toBe(0);
  });
});
