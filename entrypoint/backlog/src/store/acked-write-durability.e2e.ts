/**
 * acked-write-durability.e2e.ts — the MULTI-HOLDER residual proof for backlog
 * item `22e1c4fd-d056-4196-b93a-d2977e977ebf` ("backlog ACKNOWLEDGES writes
 * that never persist — ~15 items lost 2026-08-15 with success responses and
 * successful read-back verification", CRITICAL).
 *
 * ── What this file exists to close ──────────────────────────────────────────
 *
 * A prior debug pass verified the SINGLE-holder case, the WAL-cap branch
 * (`DEFAULT_WAL_CAP_HEADROOM_BYTES = 262_144` — 256 KiB, ceiling
 * `DEFAULT_WAL_CAP_CEILING_BYTES = 1_048_576` — 1 MiB), and the content-dead
 * `-tshm` branch against `@adhd/sox-store-adapter` (all passed → "mitigated,
 * does not reproduce"). But the ORIGINAL incident happened under **5 concurrent
 * MCP `serve` processes** (the item's own §MECHANISM: "every `backlog` CLI call
 * and every stdio MCP client is its own short-lived process opening the store
 * directly, so uncheckpointed-WAL windows are constant and numerous"). That
 * exact topology was never exercised. This suite does.
 *
 * ── The property under test (the consumer-visible outcome) ─────────────────
 *
 * A write that `backlog` ACKNOWLEDGED (`{ok:true, created:true}` with an
 * allocated uid) — issued against a store held open by 5 genuinely co-resident
 * `serve --transport mcp` processes — MUST be readable after those processes
 * are **SIGKILLed (no clean close)** and the store is reopened from a
 * **fresh OS process**. Zero acknowledged-write loss.
 *
 * ── The live-peer topology (the incident's actual surface) ─────────────────
 *
 * The historical loss mechanism (item §MECHANISM, BL-512 class) was a later
 * STALE-`-tshm` reconciliation discarding uncheckpointed WAL frames **while a
 * peer still held the store** — a write acked, then discarded by a *different*
 * process. `store-lease.ts`'s live-peer gate ("a store with a live peer is
 * never reconciled, never truncated") is the fix. The LIVE-PEER test below
 * exercises exactly that surface: a holder stays ALIVE (still holding its
 * store lease) while a fresh process opens and reads, and the acked rows must
 * still be there. The GREEN test then covers the crash topology: SIGKILL
 * leaves the messy multi-lease / `-tshm` / `-wal` post-crash state on disk and
 * forces the fresh opener to recover it.
 *
 * ── Real components only, no bypass ────────────────────────────────────────
 *
 * Spawns the REAL BUILT `dist/index.js serve --transport mcp` as genuine child
 * OS processes, drives each with a real `@modelcontextprotocol/sdk` `Client`,
 * and reads back through a fresh process. Never a mock, never an in-process
 * import of the server. (`.mcp.json` points at a DIFFERENT checkout —
 * `.worktrees/backlog-cutover/entrypoint/backlog/dist/index.js` — so it is NOT
 * the artifact this suite spawns; the suite spawns THIS repo's own built
 * `dist/index.js`.)
 *
 * The write acknowledgement is the latch (the create tool returns only after
 * the transaction commits). No unconditional sleeps — only bounded deadlines
 * (`waitPidGone`'s 15 s cap, the co-residency sample loop's 4000 iterations).
 *
 * ── Teeth (CONTROL test at the bottom) ─────────────────────────────────────
 *
 * A test that only ever passes proves nothing. The CONTROL injects the
 * incident's consumer-visible outcome directly at the durable layer: after
 * proving the acked rows survive the crash (`=== acked`), it restores the
 * store's PRE-WRITE on-disk image — the acked rows genuinely absent from
 * durable storage — and asserts the fresh-process count drops BELOW the acked
 * count. If the counter could not notice acked-but-not-persisted rows, the
 * CONTROL would fail — so the GREEN `count === acked` assertion has teeth.
 *
 * Why not literally truncate the `-wal`? On the CURRENT substrate
 * (`STORE_ADAPTER` defaults to `turso`) that is not a loss vector: turso's
 * committed rows are durable in the MAIN DB FILE, independent of the `-wal`.
 * Truncating the `-wal` and removing the sidecars did NOT drop the
 * fresh-process count (verified while authoring this control — the issue rows
 * were already in `db`). So the loss is injected by replacing the recovered
 * store image with its pre-write bytes: the same "acknowledged writes absent
 * from durable storage" outcome, applied at the layer the fresh opener reads.
 *
 * Resource lane: proc — real concurrently-running `serve` child processes + a
 * fresh reopen process against the same store, plus a crash + durable-loss
 * control.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { storeQuiescence } from '@adhd/sox-store-adapter';
import {
  mintBacklogSandbox,
  stdioSpawnOptionsForSandbox,
  type SandboxHandle,
} from '../test/helpers/spawn-backlog-bin.js';
import { buildBacklogEnv, resolveBacklogDbPath } from '../env.js';
import {
  openTestIssueStore,
  seedProject,
} from '../test/helpers/open-test-issue-store.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import type { ICreateIssueResult } from '../write/create-issue.js';
import type { IIssueQueryResult } from '../query/types.js';

/** The incident topology: five concurrent holders of the same store. */
const N_HOLDERS = 5;
/** Writes each holder fires concurrently. Bodies are large so the shared WAL
 *  grows past the adapter's 256 KiB cap (`DEFAULT_WAL_CAP_HEADROOM_BYTES`) and
 *  the multi-holder cap-flush/defer path is genuinely exercised. */
const N_PER_HOLDER = 24;
const BODY_BYTES = 80_000;
const PROJECT_NAME = 'backlog-acked-write-durability-multiholder';

/** One real spawned `serve --transport mcp` process + a connected MCP client. */
interface ServerConn {
  client: Client;
  transport: StdioClientTransport;
}

async function spawnHolder(sandbox: SandboxHandle, name: string): Promise<ServerConn> {
  const transport = new StdioClientTransport(
    stdioSpawnOptionsForSandbox(sandbox, ['serve', '--transport', 'mcp'])
  );
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  await client.listTools(); // round-trip through the real transport
  return { client, transport };
}

async function closeQuiet(conn: ServerConn): Promise<void> {
  await conn.client.close().catch(() => undefined);
  await conn.transport.close().catch(() => undefined);
}

async function callTool<T>(
  conn: ServerConn,
  name: string,
  args: Record<string, unknown>
): Promise<IOutcomeEnvelope<T>> {
  const result = await conn.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? '{}') as IOutcomeEnvelope<T>;
}

/** Fires `n` concurrent `backlog_create` calls; returns how many were ACKED ({ok:true}). */
async function createIssues(
  conn: ServerConn,
  n: number,
  projectUid: string,
  tag: string,
  bodyBytes: number
): Promise<number> {
  const body = 'x'.repeat(bodyBytes);
  const calls = Array.from({ length: n }, (_, i) =>
    callTool<ICreateIssueResult>(conn, 'backlog_create', {
      data: {
        input: {
          title: `${tag}-${i}`,
          body,
          project: projectUid,
          by: `acked-durability-${tag}`,
        },
      },
    }).then((env) => (env.ok === true ? 1 : 0))
  );
  const outcomes = await Promise.all(calls);
  return outcomes.reduce<number>((a, b) => a + b, 0);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM'; // exists but not ours
  }
}

async function sigkill(conn: ServerConn): Promise<void> {
  const pid = conn.transport.pid;
  if (pid == null) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (errCode(err) !== 'ESRCH') throw err;
  }
}

/** Bounded, tick-driven wait for a process to actually die — no unconditional sleep. */
async function waitPidGone(pid: number, deadlineMs = 15_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (!pidAlive(pid)) return;
    if (Date.now() > end) throw new Error(`pid ${pid} still alive after ${deadlineMs}ms`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Best-effort teardown: SIGKILL any survivor so a failed assertion never strands a holder. */
async function disposeHolders(holders: ServerConn[]): Promise<void> {
  for (const h of holders) {
    const pid = h.transport.pid;
    if (pid != null && pidAlive(pid)) {
      await sigkill(h).catch(() => undefined);
      await waitPidGone(pid).catch(() => undefined);
    }
  }
  for (const h of holders) await closeQuiet(h);
}

/** db + sidecar byte sizes — durable-state evidence a reviewer can re-check. */
function describeSidecars(dbPath: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const suffix of ['', '-wal', '-shm', '-tshm']) {
    try {
      out[suffix || 'db'] = statSync(dbPath + suffix).size;
    } catch {
      out[suffix || 'db'] = null;
    }
  }
  return out;
}

/**
 * Snapshots the durable store image (the main db file bytes) so the CONTROL
 * can later restore it — standing in for "the acknowledged writes never
 * reached durable storage". Used ONLY by the CONTROL test: the GREEN and
 * LIVE-PEER tests must never mutate the store out from under the mechanism
 * they prove.
 */
function snapshotStoreBytes(dbPath: string): Buffer {
  return readFileSync(dbPath);
}

/**
 * Restores a pre-write durable image over the store and drops the coordination
 * sidecars, so the next fresh opener reads exactly the snapshot's state. Returns
 * how many sidecar files it removed (evidence for the control's own report).
 */
function restoreStoreBytes(dbPath: string, image: Buffer): number {
  writeFileSync(dbPath, image);
  let removed = 0;
  for (const suffix of ['-wal', '-shm', '-tshm']) {
    try {
      unlinkSync(dbPath + suffix);
      removed++;
    } catch {
      /* absent is fine */
    }
  }
  return removed;
}

/**
 * Reads the live issue count under `projectUid` through a FRESH real
 * `serve --transport mcp` process/connection — never a writer's own
 * in-process view (the item's §VERIFICATION TRAP: a same-process read is
 * served out of that process's own uncheckpointed WAL and cannot distinguish
 * committed from uncommitted).
 */
async function freshStoredCount(
  sandbox: SandboxHandle,
  projectUid: string
): Promise<{ count: number; verifyPid: number | null }> {
  const conn = await spawnHolder(sandbox, 'durability-verify');
  try {
    const query = await callTool<IIssueQueryResult>(conn, 'backlog_query', {
      data: { input: { filter: { project: projectUid }, limit: 1000 } },
    });
    return { count: assertIssuePage(query).length, verifyPid: conn.transport.pid };
  } finally {
    await closeQuiet(conn);
  }
}

/**
 * Unwraps a `view:'list'` issue page, failing loudly on anything else.
 *
 * Narrowing is by SHAPE (`'items' in … && 'hasMore' in …`), not by
 * `view !== 'list'`: `IIssueMarkdownResult`'s `view` union includes `'list'`
 * (the markdown member is selected by `format`, not by `view`), so a
 * `view`-only discriminant does NOT exclude it and `.items` does not
 * type-check against the residual `IIssueListResult | IIssueMarkdownResult`.
 * Only `IIssueListResult` carries BOTH `items` and `hasMore` (the registry
 * views carry `items` alone), so the shape test is the precise discriminant.
 */
function assertIssuePage(env: IOutcomeEnvelope<IIssueQueryResult>): Array<{ uid: string }> {
  if (!env.ok) throw new Error(`backlog_query failed: ${JSON.stringify(env)}`);
  const data = env.data;
  if ('items' in data && 'hasMore' in data) {
    if (data.hasMore) throw new Error('issue page truncated: more than 1000 — widen the limit');
    return data.items;
  }
  throw new Error(`expected a view:'list' issue page, got ${JSON.stringify(data)}`);
}

/** Mint one isolated sandbox store seeded with exactly one project. */
async function mintSeededSandbox(): Promise<{
  sandbox: SandboxHandle;
  dbPath: string;
  projectUid: string;
}> {
  const sandbox = mintBacklogSandbox();
  try {
    const seedEnv = buildBacklogEnv({ adhdRoot: sandbox.adhdRoot, namespace: 'sandbox' });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, PROJECT_NAME);
    await seedStore.close();
    return { sandbox, dbPath, projectUid };
  } catch (err) {
    // `mintBacklogSandbox()` already created `sandbox.adhdRoot`; if seeding
    // throws before we return the handle, the caller never assigns it and its
    // `afterEach` would see `undefined` and leak the directory. Remove it here
    // so the mint's own finally is total, regardless of caller ordering.
    rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    throw err;
  }
}

describe('backlog acked-write durability — 5 concurrent MCP holders, crash-exit, fresh reopen', () => {
  let sandbox: SandboxHandle | undefined;

  afterEach(() => {
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
  });

  it(
    `GREEN: 5 REAL, simultaneously-live \`serve --transport mcp\` processes each fire ${N_PER_HOLDER} concurrent backlog_create calls (${N_HOLDERS * N_PER_HOLDER} total) at the SAME store; all are ACKED, then every process is SIGKILLed (no clean close); a fresh 6th process reopens and finds EXACTLY the acked count`,
    async () => {
      const seeded = await mintSeededSandbox();
      sandbox = seeded.sandbox;
      const { dbPath, projectUid } = seeded;

      const holders: ServerConn[] = [];
      try {
        // All 5 holders started and connected BEFORE either issues a write —
        // genuinely co-resident against one store, not sequential.
        for (let i = 0; i < N_HOLDERS; i++) holders.push(await spawnHolder(sandbox, `holder-${i}`));
        const pids = holders
          .map((h) => h.transport.pid)
          .filter((p): p is number => p != null);
        expect(pids.length, 'every holder must expose its child pid').toBe(N_HOLDERS);

        // CO-RESIDENCY LATCH (no unconditional sleep): all 5 child processes
        // are alive at the same instant. The adapter's per-connection lease
        // registry is sampled live while the concurrent writes are in flight;
        // its PEAK proves the 5 holders genuinely overlapped on the store (an
        // idle `serve` process voluntarily releases its lease after ~2 s —
        // `releaseIdleConnection()` — so a single pre-write snapshot is not the
        // right latch).
        for (const pid of pids) expect(pidAlive(pid), `holder pid ${pid} not alive`).toBe(true);

        const writesPromise = Promise.all(
          holders.map((h, i) => createIssues(h, N_PER_HOLDER, projectUid, `H${i}`, BODY_BYTES))
        );
        let maxLivePeers = 0;
        const settled = writesPromise.then(() => true);
        for (let samples = 0; samples < 4000; samples++) {
          maxLivePeers = Math.max(maxLivePeers, storeQuiescence(dbPath).livePeers.length);
          const done = await Promise.race([
            settled,
            new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
          ]);
          if (done) break;
        }
        const ackedPerHolder = await writesPromise;
        const acked = ackedPerHolder.reduce<number>((a, b) => a + b, 0);
        const sidecarsBeforeCrash = describeSidecars(dbPath);

        // Every holder must still be alive immediately before the crash, and
        // every write must have been acked — otherwise this is not the case we
        // mean to prove (a contention failure is a different finding).
        for (const pid of pids) {
          expect(pidAlive(pid), `holder pid ${pid} died before crash`).toBe(true);
        }
        expect(
          acked,
          `expected all ${N_HOLDERS * N_PER_HOLDER} writes acked ok:true (per-holder: ${JSON.stringify(
            ackedPerHolder
          )})`
        ).toBe(N_HOLDERS * N_PER_HOLDER);
        expect(
          maxLivePeers,
          'expected at least two holders to overlap on the store during the write burst'
        ).toBeGreaterThanOrEqual(2);

        // CRASH-EXIT: hard SIGKILL, no clean close, while all holders are live.
        for (const h of holders) await sigkill(h);
        for (const pid of pids) await waitPidGone(pid);
        const sidecarsAfterCrash = describeSidecars(dbPath);

        // FRESH 6th process reopens and reads — the actual durability assertion.
        const { count, verifyPid } = await freshStoredCount(sandbox, projectUid);

        console.log(
          `[durability-evidence] ${JSON.stringify({
            acked,
            ackedPerHolder,
            maxLivePeersDuringWrites: maxLivePeers,
            sidecarsBeforeCrash,
            sidecarsAfterCrash,
            persistedFreshProcess: count,
            verifyPid,
          })}`
        );

        expect(
          count,
          `acked=${acked}; a fresh process after a 5-holder crash read ${count} — ` +
            `sidecars before crash ${JSON.stringify(
              sidecarsBeforeCrash
            )}, after crash ${JSON.stringify(sidecarsAfterCrash)}`
        ).toBe(acked);
      } finally {
        await disposeHolders(holders);
      }
    },
    180_000
  );

  it(
    'LIVE-PEER: a holder that is STILL ALIVE (store lease held) does not lose its acked writes when a FRESH process opens and reads the same store — the live-peer gate is exercised at recovery',
    async () => {
      const seeded = await mintSeededSandbox();
      sandbox = seeded.sandbox;
      const { dbPath, projectUid } = seeded;

      const holders: ServerConn[] = [];
      const PER_HOLDER = 8;
      try {
        const holder = await spawnHolder(sandbox, 'live-peer-holder');
        holders.push(holder);
        const holderPid = holder.transport.pid;
        expect(holderPid, 'live-peer holder must expose its child pid').not.toBeNull();
        if (holderPid == null) return;

        const acked = await createIssues(holder, PER_HOLDER, projectUid, 'LIVE', 2048);
        expect(acked).toBe(PER_HOLDER);

        // Sample the lease registry IMMEDIATELY after the ack (well inside the
        // ~2 s idle-release window), while the holder is a genuine live peer —
        // the gate would decline any destructive reconcile against this store.
        const quiescence = storeQuiescence(dbPath);
        expect(pidAlive(holderPid), 'live-peer holder died before the fresh open').toBe(true);
        expect(
          quiescence.livePeers.length,
          `expected the live holder to hold a store lease (quiescence: ${JSON.stringify(quiescence)})`
        ).toBeGreaterThanOrEqual(1);

        // A FRESH process opens and reads WHILE the holder is still alive. If
        // the live-peer gate were absent and this open reconciled/truncated the
        // store, the acked rows would be gone and this assertion would fail.
        const { count: whilePeerLive } = await freshStoredCount(sandbox, projectUid);
        expect(pidAlive(holderPid), 'live-peer holder died during the fresh open').toBe(true);
        expect(
          whilePeerLive,
          `a fresh process read ${whilePeerLive} while a live holder had acked ${acked}`
        ).toBe(acked);

        // Then crash the holder; the same rows must survive a fresh reopen too.
        await sigkill(holder);
        await waitPidGone(holderPid);
        const { count: afterCrash } = await freshStoredCount(sandbox, projectUid);

        console.log(
          `[durability-live-peer] ${JSON.stringify({
            acked,
            livePeersAtAck: quiescence.livePeers.length,
            persistedWhilePeerLive: whilePeerLive,
            persistedAfterCrash: afterCrash,
          })}`
        );

        expect(afterCrash).toBe(acked);
      } finally {
        await disposeHolders(holders);
      }
    },
    120_000
  );

  it(
    'CONTROL (teeth): the acked rows survive the crash (=== acked); restoring the pre-write durable image — the acked rows absent from durable storage — drops the fresh-process count below acked',
    async () => {
      const seeded = await mintSeededSandbox();
      sandbox = seeded.sandbox;
      const { dbPath, projectUid } = seeded;

      const holders: ServerConn[] = [];
      const SMALL = 6;
      const BODY_BYTES_SMALL = 512;
      try {
        // Snapshot the durable store BEFORE any acked write (the seed-only
        // image). Restoring it later reproduces "the acked writes never reached
        // durable storage".
        const preWriteImage = snapshotStoreBytes(dbPath);

        const holder = await spawnHolder(sandbox, 'control-holder');
        holders.push(holder);
        const acked = await createIssues(holder, SMALL, projectUid, 'CTRL', BODY_BYTES_SMALL);
        expect(acked).toBe(SMALL);

        // Crash: SIGKILL with no clean close.
        await sigkill(holder);
        if (holder.transport.pid != null) await waitPidGone(holder.transport.pid);
        const sidecarsAtCrash = describeSidecars(dbPath);

        // 1) Durable across the crash: the fresh process sees every acked row.
        const { count: afterCrash } = await freshStoredCount(sandbox, projectUid);
        expect(
          afterCrash,
          `control: acked ${SMALL} but a fresh process after crash read ${afterCrash} ` +
            `(sidecars at crash ${JSON.stringify(sidecarsAtCrash)})`
        ).toBe(SMALL);

        // 2) Teeth: with the acked rows absent from durable storage (the
        //    pre-write image restored), the SAME fresh-process read must drop
        //    below acked. If it could not, GREEN's `count === acked` would be
        //    toothless.
        const removedSidecars = restoreStoreBytes(dbPath, preWriteImage);
        const { count: afterRestore } = await freshStoredCount(sandbox, projectUid);
        console.log(
          `[durability-control] ${JSON.stringify({
            acked,
            sidecarsAtCrash,
            persistedAfterCrash: afterCrash,
            removedSidecars,
            persistedAfterPreWriteRestore: afterRestore,
          })}`
        );
        expect(
          afterRestore,
          `control expected restoring the pre-write durable image to drop the fresh-process count below ` +
            `the ${acked} acked rows, but it still read ${afterRestore}`
        ).toBeLessThan(acked);
      } finally {
        await disposeHolders(holders);
      }
    },
    120_000
  );
});
