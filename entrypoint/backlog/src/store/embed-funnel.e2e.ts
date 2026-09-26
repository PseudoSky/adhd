/**
 * embed-funnel.e2e.ts — the funnel's headline invariant, proven against REAL
 * components at the backlog consumer seam.
 *
 * ## The invariant
 *
 * `@adhd/sox-embedding-provider`'s embedding funnel (SPEC-EMBEDDING-FUNNEL.md,
 * ADR-0020) makes `getSharedFastembedProcess()` host-aware: under the default
 * `host: 'shared'`, `createEmbeddingProvider()` is INERT (no model load, no
 * host spawn) and the first real embed dials — or peer-spawns, via
 * `ensureBackend()`'s O_EXCL spawn-lock — ONE machine-wide, self-reaping ONNX
 * host per `(model, ep, cacheDir)`. So:
 *
 *   1. **Construction spawns no host.** A host that constructs a provider and
 *      never embeds (e.g. a read-only `backlog query`) must spawn ZERO
 *      embedding hosts. Pre-funnel, `createEmbeddingProvider()` eagerly ran a
 *      warmup `embedSingle('warmup')`, which forked a private fastembed child
 *      at construction time — N such consumers meant N children.
 *   2. **N consumer PROCESSES share ONE host.** N concurrent consumers each
 *      embedding collapse onto a single peer-spawned host, never N private
 *      ones.
 *
 * Both are asserted here through the PRODUCTION seam
 * (`write/bootstrap.ts`'s `bootstrapSemanticStoreMembers`) with the REAL
 * `@adhd/sox-embedding-provider` — never a fake — driven from REAL, separate
 * consumer processes (`test/helpers/embed-funnel-consumer.ts` under `tsx`).
 * There is no in-process shortcut: the funnel is cross-process by
 * construction, so only genuine child processes can demonstrate the collapse.
 *
 * ## Why this runs by DEFAULT, with no env flag
 *
 * AGENTS.md's "Live testing is mandatory" permits an env gate for exactly one
 * reason: a PAID or EXTERNAL third-party service. fastembed is neither — it is
 * local ONNX inference over a model already cached on disk, costing nothing
 * per run and reachable with no network. So these run unflagged, and if the
 * model or the optional packages are missing they FAIL LOUDLY (a consumer
 * writing an `error-<i>` signal) rather than skipping.
 *
 * ## Isolation — never the machine's live hosts, never the production store
 *
 * Every consumer is spawned with `SOX_ECOSYSTEM_HOME` pointed at a per-test
 * temp dir, so the funnel's socket dir (`<SOX_ECOSYSTEM_HOME>/run`) — and
 * every host it spawns — is isolated from the machine's live hosts (the
 * deploy + memory-server both hold funnel hosts). Each consumer opens its own
 * real store under its signal dir — this spec's gitignored `tmp/` scratch,
 * removed in `afterEach` once the consumers are dead — never the production
 * store, and never a stray store left in the OS temp dir.
 *
 * ## NEGATIVE CONTROL (verified)
 *
 * Both tests go RED on the pre-funnel pin (`@adhd/sox-embedding-provider`
 * `^0.5.0`): test 1 because construction eagerly forked a `fastembedProcessHost`
 * child, test 2 because the pre-funnel topology has no machine-wide shared UDS
 * host at all (no funnel host names a consumer as its spawner). See the branch's report
 * for the observed raw output.
 *
 * ## Process lifecycle — the tests must never outlive an externally-killed run
 *
 * These consumers HOLD a persistent funnel UDS client connection. The shared
 * host (`@adhd/sox-embedding-provider` >= 0.6, sox ADR-0022) retires on WORK,
 * not connections — it exits its idle window after the last completed embed
 * even while clients stay attached — but a stranded consumer that keeps
 * embedding would still keep a host (and its ONNX child) alive, and a stranded
 * consumer is a leak in its own right. Two independent guards make that
 * impossible:
 *
 *   - the consumers are spawned **`detached`** (own process group) and
 *     `afterEach` reaps the whole group, on the normal path; and
 *   - the consumer carries an **absolute self-watchdog**
 *     (`embed-funnel-consumer.ts` `installSelfWatchdog`) — independent of this
 *     process — so a SIGKILLed test/gate process cannot strand it.
 *
 * `embed-funnel-watchdog.spec.ts` proves the watchdog and the parent-death
 * (reparent) path directly, in bounded wall-clock, with no parent signal.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/store/` -> repo root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER = join(HERE, '..', 'test', 'helpers', 'embed-funnel-consumer.ts');

/** Real cold ONNX model init is the slow part; a cold-load budget, not a hang. */
const E2E_TIMEOUT = 180_000;
const RENDEZVOUS_TIMEOUT = 150_000;

/** Matches the two process families an embedding consumer can spawn. */
const EMBED_HOST_CMD = /(?:embedHostMain|fastembedProcessHost)\.js/;

/** Consumers spawned by the current test; killed in `afterEach`. */
const liveConsumers: Consumer[] = [];

interface Consumer {
  child: ChildProcess;
  readonly index: number;
  stderr(): string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Spawns a real consumer process (runner under tsx) with the funnel isolated
 * to `soxHome`. `ADHD_BACKLOG_EMBEDDING_ENABLED=true` turns the semantic stack
 * on for it (the same env the in-process real-model specs use).
 */
function spawnConsumer(
  mode: 'bootstrap-only' | 'embed',
  signalDir: string,
  index: number,
  soxHome: string
): Consumer {
  const child = spawn(
    process.execPath,
    [TSX_CLI, RUNNER, mode, signalDir, String(index)],
    {
      env: {
        ...process.env,
        SOX_ECOSYSTEM_HOME: soxHome,
        ADHD_BACKLOG_EMBEDDING_ENABLED: 'true',
        // The consumer's watchdog polls THIS process (the test) and exits the
        // moment it disappears, so an externally-killed test run cannot strand
        // a consumer holding the shared host's UDS connection open.
        SOX_FUNNEL_CONSUMER_PARENT_PID: String(process.pid),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      // Its own session + process group (pgid === pid). Two reasons:
      //   1. `killConsumer` can reap the WHOLE group with one signal, so no
      //      descendant a consumer forks into its group can be missed;
      //   2. the group is independently identifiable, so an external reaper can
      //      still find and clear it even if this test process is killed.
      // The consumer is NOT left to this test alone — it carries its own
      // self-watchdog (`embed-funnel-consumer.ts` `installSelfWatchdog`), so a
      // SIGKILLed test process (the observed pre-push-gate SIGPIPE/timeout)
      // cannot strand it holding the shared host's UDS connection open.
      detached: true,
    }
  );
  // Fully detach: this process must not be kept alive by the consumer, and must
  // not be its reaper-of-record (the watchdog is).
  child.unref();
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += String(d);
  });
  const consumer: Consumer = { child, index, stderr: () => stderr };
  liveConsumers.push(consumer);
  return consumer;
}

function killConsumer(consumer: Consumer): void {
  if (consumer.child.exitCode !== null || consumer.child.signalCode !== null) return;
  const pid = consumer.child.pid;
  if (pid === undefined) return;
  // Reap the process GROUP (the consumer is detached, so pgid === pid): one
  // signal covers the consumer and any descendant it forked into its group.
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    /* group already gone, or never formed — fall back to the bare pid */
  }
  try {
    consumer.child.kill('SIGKILL');
  } catch {
    /* best-effort teardown */
  }
}

interface ProcLine {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process on the box (`ps -Ao pid,ppid,command`, headerless). */
function listProcesses(): ProcLine[] {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const procs: ProcLine[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

/** The full descendant tree of `rootPid` (BFS over `ppid`). */
function descendantsOf(rootPid: number): ProcLine[] {
  const byParent = new Map<number, ProcLine[]>();
  for (const p of listProcesses()) {
    const arr = byParent.get(p.ppid);
    if (arr) arr.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const out: ProcLine[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** A live funnel host, as described by its own argv. */
interface FunnelHost {
  pid: number;
  /** The UDS the host bound — its `--socket=` flag, verbatim. */
  socket: string;
}

/**
 * Every live funnel host (`embedHostMain`) whose `--spawner-pid=` is one of
 * `spawnerPids`. The host is spawned DETACHED, so it is never a descendant of
 * the consumer; its argv is the only authoritative link back to who spawned it.
 *
 * The socket path is read from the host's own `--socket=` flag rather than
 * assumed to live under `<SOX_ECOSYSTEM_HOME>/run`: `@adhd/sox-service-proxy`
 * >= 0.4.4 (`backendSocketPath`, BL-578) relocates a socket whose full path
 * would exceed the 104-byte `sun_path` budget to `os.tmpdir()/sox-uds/`, keyed
 * on a digest of `(socketDir, singletonKey)` — still unique to this test's run
 * dir, but no longer INSIDE it. A scratch root nested in a git worktree crosses
 * that budget, so a directory listing alone reports zero sockets there.
 */
function funnelHostsSpawnedBy(spawnerPids: ReadonlySet<number>): FunnelHost[] {
  const hosts: FunnelHost[] = [];
  for (const p of listProcesses()) {
    if (!/embedHostMain\.js/.test(p.command)) continue;
    const spawner = /--spawner-pid=(\d+)/.exec(p.command);
    const socket = /--socket=(\S+)/.exec(p.command);
    if (spawner && socket && spawnerPids.has(Number(spawner[1]))) {
      hosts.push({ pid: p.pid, socket: socket[1]! });
    }
  }
  return hosts;
}

/** Each consumer's pid plus every descendant (the `tsx` CLI forks the real node). */
function consumerPidSet(consumers: readonly Consumer[]): Set<number> {
  const pids = new Set<number>();
  for (const c of consumers) {
    const pid = c.child.pid;
    if (pid === undefined) continue;
    pids.add(pid);
    for (const d of descendantsOf(pid)) pids.add(d.pid);
  }
  return pids;
}

/** PIDs holding `socketPath` open (via `lsof`); `[]` if none do. */
function socketOwnerPids(socketPath: string): number[] {
  try {
    const out = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** Bounded await for the first of `names` to appear under `dir`; returns the name found. */
async function awaitFirstFile(
  dir: string,
  names: string[],
  deadlineMs: number
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return name;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${deadlineMs}ms waiting for one of [${names.join(
          ', '
        )}] under ${dir}`
      );
    }
    await delay(50);
  }
}

/** Per-test signal/scratch dirs, removed in `afterEach` AFTER consumers die. */
const liveSignalDirs: string[] = [];

afterEach(() => {
  // Reap consumers FIRST, then remove their scratch dirs. The order matters:
  // each consumer's store now lives under its signal dir, so removing the dir
  // while a consumer still holds the store open would pull it out from under a
  // live process (harmless on macOS, but wrong to rely on).
  for (const consumer of liveConsumers.splice(0)) killConsumer(consumer);
  for (const dir of liveSignalDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('embedding funnel — real components, real consumer processes', () => {
  it(
    'constructing the production semantic seam is INERT — it spawns ZERO embedding hosts',
    async () => {
      const signalDir = freshTmpDir('embed-funnel-inert');
      const soxHome = join(signalDir, 'sox-home');
      try {
        const consumer = spawnConsumer('bootstrap-only', signalDir, 0, soxHome);

        // Fail LOUD (never skip) if the real seam could not even produce members.
        const found = await awaitFirstFile(
          signalDir,
          ['ready-0', 'error-0'],
          RENDEZVOUS_TIMEOUT
        );
        expect(
          found,
          `consumer bootstrap failed; stderr:\n${consumer.stderr()}`
        ).toBe('ready-0');

        // The consumer now HOLDS after constructing the seam and before any
        // embed. On the funnel pin nothing was forked; pre-funnel the eager
        // warmup had already forked a `fastembedProcessHost` child here.
        const embeddingDescendants = descendantsOf(consumer.child.pid!).filter(
          (p) => EMBED_HOST_CMD.test(p.command)
        );
        expect(
          embeddingDescendants.map((p) => `${p.pid} ${p.command}`),
          'bootstrapping must not spawn an embedding host — construction is inert'
        ).toEqual([]);

        // Corroboration: no funnel host names this consumer as its spawner, and
        // none bound a socket in this isolated run dir. (The host is detached, so
        // the descendant scan above cannot see it; its argv can.)
        const hosts = funnelHostsSpawnedBy(consumerPidSet([consumer]));
        expect(
          hosts.map((h) => `${h.pid} ${h.socket}`),
          'bootstrapping must not spawn a funnel host — construction is inert'
        ).toEqual([]);
        const runDir = join(soxHome, 'run');
        const sockets = existsSync(runDir)
          ? readdirSync(runDir).filter((f) => f.endsWith('.sock'))
          : [];
        expect(sockets, `unexpected host socket(s): ${sockets.join(', ')}`).toEqual(
          []
        );
      } finally {
        // Hand the scratch dir to `afterEach` — it reaps the consumer first.
        liveSignalDirs.push(signalDir);
      }
    },
    E2E_TIMEOUT
  );

  it(
    'N concurrent consumer processes share EXACTLY ONE self-reaping embedding host',
    async () => {
      const signalDir = freshTmpDir('embed-funnel-shared');
      const soxHome = join(signalDir, 'sox-home');
      const N = 3;
      try {
        const consumers = Array.from({ length: N }, (_, i) =>
          spawnConsumer('embed', signalDir, i, soxHome)
        );

        // Every consumer bootstraps the real seam before ANY of them embeds.
        for (let i = 0; i < N; i += 1) {
          const found = await awaitFirstFile(
            signalDir,
            [`ready-${i}`, `error-${i}`],
            RENDEZVOUS_TIMEOUT
          );
          expect(
            found,
            `consumer ${i} bootstrap failed; stderr:\n${consumers[i]!.stderr()}`
          ).toBe(`ready-${i}`);
        }

        // Rendezvous: release all N to embed at once (no wall-clock reliance).
        writeFileSync(join(signalDir, 'go'), 'go');

        const dims: number[] = [];
        for (let i = 0; i < N; i += 1) {
          await awaitFirstFile(signalDir, [`done-${i}`], E2E_TIMEOUT);
          const body = JSON.parse(
            readFileSync(join(signalDir, `done-${i}`), 'utf8')
          ) as { ok: boolean; dim?: number; error?: string };
          expect(
            body.ok,
            `consumer ${i} embed failed: ${JSON.stringify(body)}; stderr:\n${consumers[
              i
            ]!.stderr()}`
          ).toBe(true);
          dims.push(body.dim!);
        }
        // All N really embedded the real 768-dim model …
        expect(dims).toEqual([768, 768, 768]);

        // … onto EXACTLY ONE peer-spawned host, spawned by one of THIS test's
        // consumers (isolated by its private SOX_ECOSYSTEM_HOME run dir).
        const hosts = funnelHostsSpawnedBy(consumerPidSet(consumers));
        const sockets = [...new Set(hosts.map((h) => h.socket))];
        expect(
          sockets.length,
          `expected exactly one funnel host socket for this test's consumers, found ${
            sockets.length
          }: ${sockets.join(', ')}`
        ).toBe(1);
        expect(
          existsSync(sockets[0]!),
          `the funnel host socket must exist on disk: ${sockets[0]}`
        ).toBe(true);

        // The socket is owned by exactly one host process …
        const procByPid = new Map(listProcesses().map((p) => [p.pid, p]));
        const hostPids = new Set<number>();
        for (const socket of sockets) {
          for (const pid of socketOwnerPids(socket)) {
            if (EMBED_HOST_CMD.test(procByPid.get(pid)?.command ?? '')) {
              hostPids.add(pid);
            }
          }
        }
        expect(
          [...hostPids].length,
          `expected exactly one embedding host process, found pids [${[
            ...hostPids,
          ].join(', ')}]`
        ).toBe(1);

        // … that is a real host, distinct from every consumer — i.e. all N
        // consumers were served by ONE process, not N private ones.
        const hostPid = [...hostPids][0]!;
        expect(
          procByPid.get(hostPid)?.command ?? '',
          'the single host must be the funnel host binary'
        ).toContain('embedHostMain');
        const consumerPids = new Set(consumers.map((c) => c.child.pid));
        expect(
          consumerPids.has(hostPid),
          'the shared host must be a separate process, not a consumer'
        ).toBe(false);
      } finally {
        // Hand the scratch dir to `afterEach` — it reaps the consumers first.
        liveSignalDirs.push(signalDir);
      }
    },
    E2E_TIMEOUT
  );
});
