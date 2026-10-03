// PERF bench for @adhd/data-query-engine's grouping surface.
//
// Run:  /opt/homebrew/bin/node bench.mjs
// from packages/data/data-query-engine (after `nx build data-query-engine`).
//
// Input: agent-dashboard/public/events.json (41,067 real events).
//
// Measures the SPEC's PERF-1..PERF-3 against a plain-node re-implementation of
// the incumbent `groupCells` core (agent-dashboard/src/lib/aggregate.ts:246-258)
// and the incumbent `buildLevel` d=3 shape, so the comparison is on THIS machine
// at THIS commit, not against a recorded number.
//
// Method: median of 5 timed reps after 1 warmup; reports ms and ns/row.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataView } from './dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EVENTS =
  process.env.DQE_EVENTS ??
  resolve(here, '../../../../../ai/scratch/agent-dashboard/public/events.json');
const N_TARGET = 41_067;
const REPLICAS = 16; // 41,067 * 16 = 657,072
const REPS = 5;
const WARMUP = 1;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function time(fn) {
  const runs = [];
  for (let i = 0; i < WARMUP + REPS; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (i >= WARMUP) runs.push(dt);
  }
  return median(runs);
}

// --- incumbent baseline: a faithful plain-node groupCells core -------------
// Two-key single pass: key = `${agent}\u0001${model}`; accumulate sum + count.
function incumbentFlat(rows) {
  const cells = new Map();
  for (const e of rows) {
    const key = `${e.agent}\u0001${e.model}`;
    let c = cells.get(key);
    if (c === undefined) {
      c = { cost: 0, n: 0 };
      cells.set(key, c);
    }
    c.cost += e.cost_usd;
    c.n += 1;
  }
  return cells;
}

// Incumbent buildLevel shape: one partitioning pass per level d = 1..3.
function incumbentRollup3(rows) {
  const dims = ['agent', 'model', 'project'];
  let last = null;
  for (let d = 1; d <= 3; d++) {
    const m = new Map();
    for (const e of rows) {
      let key = '';
      for (let i = 0; i < d; i++) key += `${e[dims[i]]}\u0001`;
      let c = m.get(key);
      if (c === undefined) {
        c = { cost: 0, n: 0 };
        m.set(key, c);
      }
      c.cost += e.cost_usd;
      c.n += 1;
    }
    last = m;
  }
  return last;
}

function run(label, ms, n) {
  console.log(
    `${label.padEnd(46)} ${ms.toFixed(2).padStart(8)} ms   ${((ms * 1e6) / n).toFixed(1).padStart(8)} ns/row   n=${n}`
  );
}

const raw = JSON.parse(readFileSync(EVENTS, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.events ?? raw.data;
if (!Array.isArray(events) || !events.length || events.length !== N_TARGET) {
  throw new Error(`expected ${N_TARGET} events in ${EVENTS}, got ${events?.length}`);
}
console.log(`events: ${events.length} from ${EVENTS}`);

// PERF-1: flat 2-key group_by + _sum + _count, engine vs incumbent.
const flatQuery = {
  group_by: ['agent', 'model'],
  aggregate: { cost_usd: { _sum: 'cost_usd' }, events: { _count: true } },
};
const engineFlat = time(() => new DataView(events, flatQuery).view());
const incFlat = time(() => incumbentFlat(events));
run('PERF-1 engine flat [agent,model] +sum +count', engineFlat, events.length);
run('PERF-1 incumbent single-pass baseline', incFlat, events.length);
console.log(`PERF-1 ratio engine/incumbent = ${(engineFlat / incFlat).toFixed(2)}x (target <= 2x)\n`);

// PERF-2: rollup d=3, engine vs incumbent buildLevel-shape.
const rollupQuery = {
  group_by: { _rollup: ['agent', 'model', 'project'] },
  aggregate: { cost_usd: { _sum: 'cost_usd' } },
};
const engineRollup = time(() => new DataView(events, rollupQuery).view());
const incRollup = time(() => incumbentRollup3(events));
run('PERF-2 engine rollup[agent,model,project]', engineRollup, events.length);
run('PERF-2 incumbent buildLevel d=3 shape', incRollup, events.length);
console.log(`PERF-2 ratio engine/incumbent = ${(engineRollup / incRollup).toFixed(2)}x (target <= 1x)\n`);

// PERF-3: ns/row must not grow with N (scaled input).
const big = new Array(events.length * REPLICAS);
for (let i = 0; i < REPLICAS; i++) {
  for (let j = 0; j < events.length; j++) big[i * events.length + j] = events[j];
}
const engineFlatBig = time(() => new DataView(big, flatQuery).view());
run('PERF-3 engine flat @ N=657,072', engineFlatBig, big.length);
const nsSmall = (engineFlat * 1e6) / events.length;
const nsBig = (engineFlatBig * 1e6) / big.length;
console.log(
  `PERF-3 ns/row ratio big/small = ${(nsBig / nsSmall).toFixed(2)}x (target <= 1.5x)  [${nsSmall.toFixed(1)} -> ${nsBig.toFixed(1)} ns/row]`
);
