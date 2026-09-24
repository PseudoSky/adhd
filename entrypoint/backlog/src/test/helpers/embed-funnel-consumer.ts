/**
 * embed-funnel-consumer.ts — the REAL consumer driver for
 * `embed-funnel.spec.ts`. A standalone process (run under `tsx`) that opens a
 * real backlog store, bootstraps the PRODUCTION semantic seam
 * (`bootstrapSemanticStoreMembers` — the exact path `api.ts`'s
 * `writeHandle`/`queryHandle` use), and either (a) holds after construction so
 * the parent can count the embedding hosts that construction did (not) spawn,
 * or (b) waits on the parent's go-latch and performs one REAL embed, so N of
 * these running concurrently prove the funnel's headline: N consumer PROCESSES
 * collapse onto ONE peer-spawned embedding host.
 *
 * It is NOT a test file (no `.spec`/`.test` suffix) — vitest's `include`
 * glob (`src/**\/*.{test,spec}.*`) never collects it, and `tsconfig.lib.json`
 * excludes `src/test/**`, so it never ships in `dist/`.
 *
 * ## Why a real process (not an in-process client)
 *
 * The funnel is cross-process by construction: `getSharedFastembedProcess()`
 * returns a `FunneledFastembedClient` that dials (and peer-spawns) a machine-
 * wide host keyed on `(model, ep, cacheDir)`, and `ensureBackend()`'s O_EXCL
 * spawn-lock is what collapses a thundering herd. A single process has one
 * accessor singleton, so only genuinely SEPARATE consumer processes can
 * demonstrate (or fail to demonstrate) the collapse. Nothing here is faked:
 * the real `@adhd/sox-embedding-provider` loads the real bge-base-en-v1.5
 * model on first use and routes it through the real host.
 *
 * ## Protocol (files, so it is deterministic and inspectable)
 *
 *   argv: <mode> <signalDir> <index>
 *     mode = 'bootstrap-only' | 'embed'
 *
 *   The consumer writes, in signals under `<signalDir>`:
 *     - `ready-<index>`  once the production seam returned real members
 *     - `error-<index>`  (instead) if the seam could not produce them
 *     - `done-<index>`   (embed mode) `{"ok":true,"dim":768}` after one real
 *                        embed, or `{"ok":false,"error":…}` if it threw
 *   In `embed` mode it waits for the parent's `go` latch before embedding;
 *   both modes then HOLD so any host they spawned stays attributable for the
 *   parent's count — but never forever: the parent reaps them on the normal
 *   path, and a self-watchdog (`installSelfWatchdog`) exits them if the parent
 *   dies first or never signals, so an externally-killed test process cannot
 *   strand a consumer (and, through it, a shared host).
 *
 * ## Isolation
 *
 * `SOX_ECOSYSTEM_HOME` is set by the parent to a per-test temp dir, so the
 * funnel's socket dir (`<SOX_ECOSYSTEM_HOME>/run`) — and therefore every host
 * this consumer spawns — is isolated from the machine's live hosts. This
 * consumer's own store likewise lives under the parent's signal dir (the spec's
 * gitignored `tmp/` scratch) and is removed with that dir on teardown; it is
 * never the machine's real store. The model cache is deliberately left at its
 * default (already populated), so the run stays fast and never downloads.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openGraphBacklogStore } from '../../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../../env.js';
import { bootstrapSemanticStoreMembers } from '../../write/bootstrap.js';

const mode = process.argv[2];
const signalDir = process.argv[3];
const index = Number(process.argv[4] ?? '0');

if (mode !== 'bootstrap-only' && mode !== 'embed') {
  process.stderr.write(`embed-funnel-consumer: unknown mode ${String(mode)}\n`);
  process.exit(2);
}
if (!signalDir) {
  process.stderr.write('embed-funnel-consumer: signalDir required\n');
  process.exit(2);
}

/** Writes a signal file atomically-ish (writeFileSync of a complete body). */
function signal(name: string, body: unknown = {}): void {
  writeFileSync(join(signalDir, name), JSON.stringify(body));
}

/** Bounded await for a latch file the parent creates (never wall-clock-gated assertions). */
async function waitForFile(name: string, deadlineMs: number): Promise<void> {
  const path = join(signalDir, name);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { existsSync } = await import('node:fs');
    if (existsSync(path)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${deadlineMs}ms waiting for latch ${name}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Holds the process open until the parent signals, so spawned children stay attributable. */
function holdForever(): Promise<never> {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  return new Promise<never>(() => setInterval(() => undefined, 1_000));
}

/** Env knob for the consumer's own absolute lifetime bound (ms). */
export const WATCHDOG_ENV = 'SOX_FUNNEL_CONSUMER_WATCHDOG_MS';
/**
 * Env carrying the pid of the process that OWNS this consumer (the test/gate
 * process). The watchdog polls it and exits the moment it disappears. Set by
 * the spawning spec from its own `process.pid`.
 */
export const PARENT_PID_ENV = 'SOX_FUNNEL_CONSUMER_PARENT_PID';
/**
 * Default absolute lifetime bound. Deliberately generous (10 min) so it can
 * never trip a legitimate cold-model run — the spec budgets 180 s per test.
 * The parent-lease poll below is what actually bounds an orphan to ~1 s; this
 * timer only covers the pathological case of an owner that stays alive but
 * wedged and never signals.
 */
export const DEFAULT_WATCHDOG_MS = 600_000;
/** How often the parent-lease poll runs (ms). */
const PARENT_POLL_MS = 1_000;

/** `kill(pid, 0)` — true while `pid` exists (EPERM means it exists but is not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Absolute self-watchdog — the load-bearing half of the process-leak fix.
 *
 * Why the consumer must self-terminate: a reaper that lives in the PARENT
 * cannot be relied on. When the test/gate process is killed externally (the
 * observed pre-push-gate SIGPIPE/timeout), the spec's `afterEach` teardown
 * never runs, and a consumer parked in `holdForever()` would keep its funnel
 * UDS client connection open forever — which is exactly what pins the shared
 * embedding host and its ONNX child (the host correctly refuses to reap while
 * a client is attached). The consumer therefore must be unable to outlive its
 * owner on its own:
 *
 *   1. **parent lease** — the owning process's pid is passed in the
 *      environment (`PARENT_PID_ENV`); we poll it and exit within ~one interval
 *      of it disappearing. This bounds the observed `kill -9 <test process>`
 *      mode to ~1 s instead of forever.
 *   2. **absolute lifetime bound** — an unref'd timer as a backstop for an
 *      owner that stays alive but wedged and never signals us.
 *
 * Either exit closes the UDS socket, which is the host's only reason to stay
 * up; the host then self-reaps on its own idle grace. Installed before
 * `main()` so it is armed during the slow cold-model prefix too.
 *
 * ── Why an explicit pid lease, not `process.ppid` ──────────────────────────────
 *
 * `process.ppid` is captured ONCE at process start and is a plain cached value
 * here (verified: `Object.getOwnPropertyDescriptor(process, 'ppid')` is a
 * `value` descriptor, not a getter), so it never reflects a reparent — polling
 * it can never see the owner die. Worse, the consumer is not a direct child of
 * the owner: `tsx` runs the script under a wrapper process, so the consumer's
 * real parent is that wrapper (which itself survives, orphaned, when the owner
 * dies). The owner's pid carried explicitly in the environment is the only
 * reliable signal, and it works through the wrapper.
 */
export function installSelfWatchdog(): void {
  const raw = process.env[WATCHDOG_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const maxLifetimeMs =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WATCHDOG_MS;

  const bail = (why: string): void => {
    try {
      process.stderr.write(`embed-funnel-consumer: self-watchdog: ${why}\n`);
    } catch {
      /* the owner's stderr pipe may already be gone — nothing more to do */
    }
    process.exit(0);
  };

  const lifetime = setTimeout(
    () => bail(`absolute lifetime ${maxLifetimeMs}ms exceeded`),
    maxLifetimeMs
  );
  // Must not itself keep the process alive: `holdForever()` (or an in-flight
  // step) already holds the loop. This only needs to fire if we are still here.
  lifetime.unref?.();

  const rawParent = process.env[PARENT_PID_ENV];
  const parentPid = rawParent === undefined ? Number.NaN : Number(rawParent);
  if (Number.isInteger(parentPid) && parentPid > 0 && parentPid !== process.pid) {
    const poll = setInterval(() => {
      if (!isPidAlive(parentPid)) bail(`owning process pid ${parentPid} is gone`);
    }, PARENT_POLL_MS);
    poll.unref?.();
  }
}

// Arm the watchdog before `main()` does any work, so an owner killed during the
// cold-store/model prefix still cannot strand this process.
installSelfWatchdog();

async function main(): Promise<void> {
  // A store per consumer, under the parent's signal dir so the spec's teardown
  // removes it with everything else. It is deliberately NOT a `mkdtemp` in the
  // OS temp dir: the spec reaps consumers with SIGKILL, so nothing here can run
  // on that path, and a per-run `mkdtemp` would accumulate one stray store per
  // consumer per run. `signalDir` is the spec's `tmp/backlog/…` (AGENTS.md §10's
  // sanctioned, gitignored scratch root), and the spec removes it after the
  // consumers are dead. Never the machine's real store.
  const dir = join(signalDir, `store-${index}`);
  mkdirSync(dir, { recursive: true });
  const store = await openGraphBacklogStore(join(dir, 'backlog.db'));
  const env = buildBacklogEnv({ adhdRoot: dir });

  // The PRODUCTION seam. On the funnel pin this is INERT for construction:
  // it builds a real provider but loads no model and spawns no host here.
  const members = await bootstrapSemanticStoreMembers(
    store.adapter,
    store.graph,
    env.config.embedding
  );

  if (!members.search || !members.embedding) {
    signal(`error-${index}`, { error: 'bootstrap returned no search/embedding members' });
    process.exit(3);
  }

  signal(`ready-${index}`);

  if (mode === 'bootstrap-only') {
    await holdForever();
    return;
  }

  // embed mode: rendezvous with the other consumers, then embed for real.
  await waitForFile('go', 150_000);
  try {
    const vec = await members.embedding.embedDocument(
      'Funnel consumer document about torque sensors and conveyor belts'
    );
    signal(`done-${index}`, { ok: true, dim: vec.length });
  } catch (err) {
    signal(`done-${index}`, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await holdForever();
}

main().catch((err) => {
  process.stderr.write(
    `embed-funnel-consumer fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
