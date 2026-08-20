#!/usr/bin/env node
/**
 * verify-telemetry-convergence.cjs — negative-control proof for
 * BUG-BACKLOG-TELEMETRY-001 (single @adhd/sox-telemetry instance).
 *
 * The bug: @adhd/backlog resolved TWO copies of @adhd/sox-telemetry — 0.2.0
 * (via a stale @adhd/sox-graph-store@0.8.4 whose internal deps published as
 * EXACT pins) and 0.2.1 (via @adhd/sox-store-adapter@0.7.0's caret range).
 * sox-telemetry keeps its sink in MODULE scope, so the bin guard's
 * `initTelemetry()` on one copy never configured the other, and every store
 * record emitted through the other copy was silently dropped (the BL-404
 * one-shot stderr warning fires instead).
 *
 * The fix (repo A): bump `@adhd/sox-graph-store` to ^0.8.6 (the first release
 * whose internal deps publish as CARET ranges) and `@adhd/sox-telemetry` to
 * ^0.2.1 (matching store-adapter's floor), so every edge floats to ONE copy.
 *
 * This script asserts the three acceptance criteria against an INSTALLED
 * backlog, gated on process exit codes (never stdout greps):
 *
 *   (a) require.resolve('@adhd/sox-telemetry') from BOTH @adhd/backlog and
 *       @adhd/sox-store-adapter returns the SAME physical path;
 *   (b) `backlog version` exits 0 AND prints no "emitting with no
 *       initTelemetry" warning on stderr;
 *   (c) `backlog stats` appends a record to
 *       ~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-<date>.jsonl stamped
 *       service:'backlog' role:'cli'.
 *
 * RED (the bug): point --backlog-dist / --backlog-bin at the frozen global
 * install — all three fail. GREEN (the fix): point them at a fresh install of
 * the republished package — all three pass.
 *
 * Usage:
 *   node entrypoint/backlog/scripts/verify-telemetry-convergence.cjs \
 *     --backlog-dist <path/to/@adhd/backlog/dist/index.js> \
 *     --backlog-bin  <path/to/backlog executable>
 */

const { spawnSync } = require('node:child_process');
const { readFileSync, statSync, existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { homedir } = require('node:os');
const { join } = require('node:path');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
};

const backlogDist = flag('backlog-dist');
const backlogBin = flag('backlog-bin');
if (!backlogDist || !backlogBin) {
  console.error('usage: verify-telemetry-convergence.cjs --backlog-dist <dist/index.js> --backlog-bin <bin>');
  process.exit(2);
}

const failures = [];
const requireFrom = createRequire(backlogDist.endsWith('.js') ? backlogDist : join(backlogDist, 'index.js'));

// ── (a) single physical sox-telemetry instance ──────────────────────────────
try {
  const fromBacklog = requireFrom.resolve('@adhd/sox-telemetry');
  const storeAdapter = requireFrom.resolve('@adhd/sox-store-adapter');
  const fromStoreAdapter = createRequire(storeAdapter).resolve('@adhd/sox-telemetry');
  console.log(`(a) telemetry from backlog:       ${fromBacklog}`);
  console.log(`(a) telemetry from store-adapter: ${fromStoreAdapter}`);
  if (fromBacklog === fromStoreAdapter) {
    console.log('(a) PASS — one physical @adhd/sox-telemetry instance');
  } else {
    failures.push('(a) two distinct @adhd/sox-telemetry instances resolved');
    console.error('(a) FAIL — split instance');
  }
} catch (e) {
  failures.push(`(a) resolution error: ${e.message}`);
  console.error(`(a) FAIL — ${e.message}`);
}

// ── (b) `backlog version` exits 0 with no initTelemetry warning ─────────────
try {
  const res = spawnSync(backlogBin, ['version'], { encoding: 'utf8' });
  const versionExit = res.status === null ? -1 : res.status;
  const warned = (res.stderr || '').includes('emitting with no initTelemetry');
  if (versionExit === 0 && !warned) {
    console.log('(b) PASS — backlog version exit 0, no initTelemetry warning');
  } else {
    failures.push(`(b) version exit ${versionExit}, warned=${warned}`);
    console.error(`(b) FAIL — exit ${versionExit}, warning present: ${warned}`);
  }
} catch (e) {
  failures.push(`(b) version failed: ${e.message}`);
  console.error(`(b) FAIL — ${e.message}`);
}

// ── (c) `backlog stats` appends a service:'backlog' role:'cli' record ───────
try {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(homedir(), '.adhd', 'sox-ecosystem', 'backlog', 'logs', `backlog.cli-${today}.jsonl`);
  const before = existsSync(logFile) ? statSync(logFile).size : 0;

  const stats = spawnSync(backlogBin, ['stats'], { encoding: 'utf8' });
  if (stats.status !== 0) {
    failures.push(`(c) backlog stats exited ${stats.status}`);
    console.error(`(c) FAIL — stats exit ${stats.status}`);
  } else {
    const after = existsSync(logFile) ? statSync(logFile).size : 0;
    if (after <= before) {
      failures.push('(c) no new record appended after backlog stats');
      console.error('(c) FAIL — log file did not grow');
    } else {
      const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-1)[0];
      const rec = JSON.parse(tail);
      const ok = rec.service === 'backlog' && rec.role === 'cli';
      console.log(`(c) PASS — appended ${after - before} bytes, last record service=${rec.service} role=${rec.role}`);
      if (!ok) failures.push(`(c) last record service=${rec.service} role=${rec.role}, expected backlog/cli`);
    }
  }
} catch (e) {
  failures.push(`(c) stats check error: ${e.message}`);
  console.error(`(c) FAIL — ${e.message}`);
}

console.log(failures.length === 0 ? '\nRESULT: GREEN (all three invariants hold)' : `\nRESULT: RED (${failures.length} failure(s))`);
process.exit(failures.length === 0 ? 0 : 1);
