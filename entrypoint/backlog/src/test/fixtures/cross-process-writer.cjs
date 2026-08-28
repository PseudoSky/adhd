'use strict';
/**
 * cross-process-writer.cjs — a REAL separate-process writer for
 * concurrency-scale.spec.ts's cross-process checks (BUG-039).
 *
 * Opens the SAME scratch db file via the built dist's store adapter
 * (openGraphBacklogStore) — no serve lock — then BLOCKS on a file-based
 * start barrier before its first create, so two writers begin allocating
 * from the IDENTICAL initial store state at (nearly) the same instant.
 * That cold-start synchronization is what makes the allocator's
 * cross-process TOCTOU race manifest deterministically (mirrors the
 * thread tests' SharedArrayBuffer gate; processes get a file barrier).
 *
 * Handshake: after store open, writes <REPRO_ROOT>/ready-<tag>, then polls
 * for <REPRO_ROOT>/GO (bounded — never sleeps the test). Then creates N
 * items in `family`, reports per-outcome counts, closes, exits 0.
 *
 * Usage: node cross-process-writer.cjs <dbPath> <tag> <N> <family>
 * Env:   REPRO_DIST = absolute path to the built dist/index.js
 *        REPRO_ROOT = temp root (isolates env/config side effects; barrier lives here)
 *
 * The item repo is fixed at 'repro'; the spec filters on it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { openGraphBacklogStore, buildBacklogEnv, createItem, closeGraphBacklogStore } = require(process.env.REPRO_DIST);

const dbPath = process.argv[2];
const tag = process.argv[3];
const N = Number(process.argv[4] || 250);
const family = process.argv[5] || 'BUG-REPRO';
const root = process.env.REPRO_ROOT;

async function waitForGo() {
  const go = path.join(root, 'GO');
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(go)) {
    if (Date.now() > deadline) throw new Error(`${tag}: GO barrier never appeared`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

(async () => {
  const env = buildBacklogEnv({ adhdRoot: root });
  const store = await openGraphBacklogStore(dbPath, 5000);
  const ctx = { store, env };
  fs.writeFileSync(path.join(root, `ready-${tag}`), 'ready');
  await waitForGo();
  let ok = 0, rejected = 0, threw = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await createItem(ctx, { family, title: `${tag}-${i}`, body: 'x', repo: 'repro' });
      if (r && r.ok === false) rejected += 1;
      else ok += 1;
    } catch (e) {
      threw += 1;
      if (threw <= 1) console.error(`${tag}: threw:`, String(e && e.message || e).slice(0, 120));
    }
  }
  await closeGraphBacklogStore(store);
  // Fatal failures exit non-zero; silent loss (the BUG-039 bug) exits 0 so the
  // SPEC's stored-count assertion is what detects it.
  process.stdout.write(JSON.stringify({ tag, ok, rejected, threw }) + '\n');
  process.exit(threw > 0 || rejected > 0 ? 2 : 0);
})().catch((e) => {
  console.error(`${tag}: FATAL:`, String(e && e.message || e));
  process.exit(1);
});
