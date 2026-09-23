/**
 * serve.singleton.spec.ts — durable proof that `backlog serve` does NOT need
 * a `[inv:singleton]` guard: two REAL, concurrently-running `backlog serve
 * --transport mcp` processes against the SAME store, driven by real MCP
 * clients issuing sustained concurrent writes, persist exactly what they
 * report — never corrupted, never lost.
 *
 * **Why this file no longer tests lock-refusal.** This suite used to prove
 * the opposite: that a second `serve` against a live store was REFUSED by a
 * PID-file mutex (`store/serve-lock.ts`, since deleted). That lock was built
 * after a real incident — two stray concurrent `serve` processes corrupted a
 * production store, attributed at the time to the upstream Turso WAL race
 * tursodatabase/turso#7833/#8348. Deeper investigation (reading
 * `@adhd/sox-store-adapter`'s own source directly) found:
 *
 *   1. The adapter's WAL-checkpoint strategy is HARDCODED to `'gated'` in
 *      production — its own doc comment states no caller may select
 *      `'ungated'` outside a test, so real `backlog` code can never reach
 *      the unguarded TRUNCATE path the corruption required.
 *   2. The adapter's own internal safety experiment
 *      (`wal-truncate-safety-experiment`, 2026-08-18) ran 1,180 concurrent-
 *      writer trials hunting exactly this crash class and found zero
 *      SIGABRT, zero integrity damage.
 *   3. The ACTUAL historical corruption traced (via the adapter's own
 *      `BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY` doc comments) to a
 *      since-FIXED bug where `close()` checked store quiescence under a raw,
 *      non-canonicalized path, wrongly concluded the store was idle, and
 *      TRUNCATEd while a live peer still held it — reachable with NO race at
 *      all, only a path-spelling bug. `_canonicalDb`/`coordPath` now enforce
 *      canonical-path coordination everywhere in the pinned adapter version
 *      (`@adhd/sox-store-adapter@0.9.1`).
 *
 * The lock was therefore defense-in-depth against a scenario no real
 * `backlog` code path can produce — and the user has an explicit standing
 * requirement for this rewrite that MCP/the API must never lock. See
 * STATE.md A17 for the full removal record, including the manual 3-trial,
 * 90-second-per-trial empirical re-verification that preceded this rewrite
 * (zero failures, exact read-back counts every trial).
 *
 * **What THIS suite proves, and how.** Same "never a bypass" standard as
 * `serve.spec.ts`/`serve.singleton.spec.ts`'s predecessor: spawns the REAL
 * BUILT `dist/index.js serve --transport mcp` — exactly what `.mcp.json`
 * invokes — as genuine child OS processes, drives each with a real
 * `@modelcontextprotocol/sdk` `Client`, and fires a sustained batch of
 * concurrent `backlog_create` calls from BOTH processes at once against the
 * SAME sandboxed store. A fresh THIRD connection (after both writers have
 * fully shut down) then re-queries the store and asserts the persisted count
 * is EXACTLY the number of `ok:true` responses both processes reported —
 * proving no lost writes and no corruption under real concurrent multi-
 * process load, with no lock coordinating the two servers at all. This is a
 * scaled-down (CI-appropriate), permanent version of the ad hoc manual proof
 * above — a few seconds of real concurrent load is enough to prove the
 * property in a unit-test context; the 90-second runs were a one-time,
 * deliberately extreme verification, not something to bake into every run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  mintBacklogSandbox,
  stdioSpawnOptionsForSandbox,
  type SandboxHandle,
} from './test/helpers/spawn-backlog-bin.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';
import type { IOutcomeEnvelope } from './envelope.js';
import type { ICreateIssueResult } from './write/create-issue.js';
import type { IIssueQueryResult } from './query/types.js';

/** One real spawned `serve --transport mcp` process + connected MCP client. */
interface ServerConn {
  client: Client;
  transport: StdioClientTransport;
}

async function spawnServerConn(
  sandbox: SandboxHandle,
  name: string
): Promise<ServerConn> {
  const transport = new StdioClientTransport(
    stdioSpawnOptionsForSandbox(sandbox, ['serve', '--transport', 'mcp'])
  );
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  await client.listTools(); // round-trip through the real transport before issuing writes
  return { client, transport };
}

async function closeServerConn(conn: ServerConn): Promise<void> {
  await conn.client.close().catch(() => undefined);
  await conn.transport.close().catch(() => undefined);
}

/** Fires `n` concurrent `backlog_create` calls over ONE connection, returns how many reported `ok:true`. */
async function createSustained(
  conn: ServerConn,
  n: number,
  projectUid: string,
  tag: string
): Promise<number> {
  const calls = Array.from({ length: n }, (_, i) =>
    conn.client
      .callTool({
        name: 'backlog_create',
        arguments: {
          data: {
            input: {
              title: `${tag}-${i}`,
              body: `sustained concurrent write ${tag}/${i}`,
              project: projectUid,
              by: `serve.singleton.spec-${tag}`,
            },
          },
        },
      })
      .then((result) => {
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(
          content[0]?.text ?? '{}'
        ) as IOutcomeEnvelope<ICreateIssueResult>;
        return parsed.ok === true;
      })
  );
  const outcomes = await Promise.all(calls);
  return outcomes.filter(Boolean).length;
}

/** Counts LIVE issues under `projectUid` through a FRESH MCP connection/process — never a writer's own view. */
async function storedCount(
  sandbox: SandboxHandle,
  projectUid: string
): Promise<number> {
  const conn = await spawnServerConn(sandbox, 'singleton-verify');
  try {
    const result = await conn.client.callTool({
      name: 'backlog_query',
      arguments: {
        data: { input: { filter: { project: projectUid }, limit: 1000 } },
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(
      content[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<IIssueQueryResult>;
    if (!parsed.ok) throw new Error(`backlog_query failed: ${content[0]?.text}`);
    if (parsed.data.view !== 'list')
      throw new Error(`expected view:'list', got ${parsed.data.view}`);
    if (parsed.data.hasMore)
      throw new Error(
        'storedCount: more than 1000 issues under this project — widen the limit, do not silently under-count'
      );
    return parsed.data.items.length;
  } finally {
    await closeServerConn(conn);
  }
}

const N_PER_WRITER = 60;

describe('backlog serve — no [inv:singleton] guard: two concurrent real processes against the SAME store never lose or corrupt writes', () => {
  let sandbox: SandboxHandle | undefined;

  afterEach(async () => {
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
  });

  it(
    `GREEN: two REAL, simultaneously-live \`serve --transport mcp\` processes against the SAME store each fire ${N_PER_WRITER} concurrent backlog_create calls (${
      N_PER_WRITER * 2
    } total, no lock coordinating them); both stay up and answering throughout, and a fresh reopen finds exactly the number of writes reported ok:true`,
    async () => {
      sandbox = mintBacklogSandbox();

      const seedEnv = buildBacklogEnv({
        adhdRoot: sandbox.adhdRoot,
        namespace: 'sandbox',
      });
      seedEnv.ensureDirs();
      const dbPath = resolveBacklogDbPath(seedEnv);
      const seedStore = await openTestIssueStore(dbPath);
      const { projectUid } = await seedProject(
        seedStore,
        'serve-singleton-no-lock-project'
      );
      await seedStore.close();

      // Both processes started and connected BEFORE either issues a single
      // write — proves they are genuinely co-resident against the same
      // store, not merely sequential.
      const a = await spawnServerConn(sandbox, 'singleton-a');
      const b = await spawnServerConn(sandbox, 'singleton-b');

      try {
        // Sustained concurrent load: both processes fire their full batch of
        // creates at once (`Promise.all` across both connections), not
        // staggered — the exact condition the old lock would have refused
        // outright.
        const [aOk, bOk] = await Promise.all([
          createSustained(a, N_PER_WRITER, projectUid, 'A'),
          createSustained(b, N_PER_WRITER, projectUid, 'B'),
        ]);

        expect(aOk).toBe(N_PER_WRITER);
        expect(bOk).toBe(N_PER_WRITER);

        // Both survivors are still alive and answering AFTER the sustained
        // concurrent load — neither crashed, neither was refused.
        const stillA = await a.client.listTools();
        const stillB = await b.client.listTools();
        expect(stillA.tools.length).toBeGreaterThan(0);
        expect(stillB.tools.length).toBeGreaterThan(0);
      } finally {
        await closeServerConn(a);
        await closeServerConn(b);
      }

      // Fresh THIRD process/connection, opened only after both writers have
      // fully shut down — never a writer's own in-process view, which is
      // exactly what would let corrupted/lost writes go undetected.
      const persisted = await storedCount(sandbox, projectUid);
      expect(
        persisted,
        `expected exactly ${
          N_PER_WRITER * 2
        } persisted rows (both processes reported ok:true for all of them, no lock coordinating them), fresh reopen found ${persisted}`
      ).toBe(N_PER_WRITER * 2);
    },
    30_000
  );
});
