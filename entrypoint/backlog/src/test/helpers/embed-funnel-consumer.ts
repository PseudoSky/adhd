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
 *   both modes then HOLD until the parent kills them (SIGTERM), so any host
 *   they spawned stays attributable for the parent's count.
 *
 * ## Isolation
 *
 * `SOX_ECOSYSTEM_HOME` is set by the parent to a per-test temp dir, so the
 * funnel's socket dir (`<SOX_ECOSYSTEM_HOME>/run`) — and therefore every host
 * this consumer spawns — is isolated from the machine's live hosts. The model
 * cache is deliberately left at its default (already populated), so the run
 * stays fast and never downloads.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

async function main(): Promise<void> {
  // A store per consumer, under a throwaway tmp dir — never the real one.
  const dir = mkdtempSync(join(tmpdir(), `embed-funnel-consumer-${index}-`));
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
