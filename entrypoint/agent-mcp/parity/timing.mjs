// PARITY-INSTRUMENT-ONLY
// Fair timing (SCOPE-R10-prep, PARITY-R10-prep AC1). Pure. Switched on per round by `ledger.profile.fairTiming: true`; every record written before R10 is untouched.
//
// The defect it fixes (R9 triage-2): the graded wall of arm C carried ~5.0 s of C-only MEASUREMENT time (a fixed 1.5 s sleep, 1.283 s setup, 2.208 s client poll lag)
// that arm A did not, and A's own 0.62 s overhead was "unattributed". One rule now applies to every arm:
//
//     graded time of a phase = the prompt is handed to the product  ->  the product's own final result.
//       A: the `claude -p` turn is spawned and the prompt written to its stdin  ->  the `result` stream event arrives (not the process exit).
//       B/C: the `task` call is issued                                         ->  the server's own `completedAt` of the task (not the moment a client poll saw it).
//     graded wall = the sum of those windows. Everything else is harness time, split into the SAME named segments for A, B and C.
//
// Both arms write the same named marks (epoch ms). Segments, in order, partition the run exactly (residual 0 by construction):
//     run.start -> p1.start                    setup          (A: fixtures, mcp config, argv; C: server boot, agent_create, session)
//     p<i>.start -> p<i>.engineEnd             WINDOW         graded
//     p<i>.engineEnd -> p<i>.observed          lag            (A: process exit after the result event; C: client sees the terminal status)
//     p<i>.observed -> p<i>.hiddenDone         verification   (hidden test suite + file reads: identical work, both arms)
//     p<i>.hiddenDone -> p<i+1>.start          handoff        (argv / submit preparation)
//     p<last>.hiddenDone -> accounting.done    accounting     (A: 0; C: a condition-based wait on usage rows + the usage queries; NO fixed sleep)
//     accounting.done -> run.end               teardown       (server close, capture close, analysis)
// Boot time (A: spawn -> `system init` of each turn, inside the window; C: server connect + tools/list, inside setup) is reported beside the split, never subtracted.

export class TimingError extends Error {}
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Build the ordered mark names for `n` phases. */
export function markOrder(n) {
  const o = ['run.start'];
  for (let i = 1; i <= n; i++) o.push(`p${i}.start`, `p${i}.engineEnd`, `p${i}.observed`, `p${i}.hiddenDone`);
  o.push('accounting.done', 'run.end');
  return o;
}
const phaseCount = (m) => { let n = 0; while (fin(m[`p${n + 1}.start`])) n++; return n; };

/**
 * The fair duration facts of ONE run from its marks (array of `{n, ms}`; the last write of a name wins).
 * @returns {{fairTiming:true, graded:'fairWallMs', wallMs:number, runWallMs:number, windowsMs:number[], observedSumMs:number, overheadMs:number,
 *   split:{setupMs:number, lagMs:number, verificationMs:number, handoffMs:number, accountingMs:number, teardownMs:number, residualMs:number}, lagByPhaseMs:number[]}}
 * @throws {TimingError} a missing or non-monotonic mark (never a silent partial number).
 */
export function fairDuration(marks) {
  if (!Array.isArray(marks)) throw new TimingError('marks must be an array of {n, ms}');
  const m = {}; for (const x of marks) if (x && typeof x.n === 'string' && fin(x.ms)) m[x.n] = x.ms;
  const n = phaseCount(m); if (n === 0) throw new TimingError('no phase start mark (p1.start)');
  const order = markOrder(n);
  for (const k of order) if (!fin(m[k])) throw new TimingError(`missing mark ${k}`);
  for (let i = 1; i < order.length; i++) if (m[order[i]] < m[order[i - 1]]) throw new TimingError(`non-monotonic marks: ${order[i]} (${m[order[i]]}) is before ${order[i - 1]} (${m[order[i - 1]]})`);
  const windowsMs = []; const lagByPhaseMs = []; let verificationMs = 0; let handoffMs = 0; let observedSumMs = 0;
  for (let i = 1; i <= n; i++) {
    windowsMs.push(m[`p${i}.engineEnd`] - m[`p${i}.start`]); lagByPhaseMs.push(m[`p${i}.observed`] - m[`p${i}.engineEnd`]);
    observedSumMs += m[`p${i}.observed`] - m[`p${i}.start`];
    verificationMs += m[`p${i}.hiddenDone`] - m[`p${i}.observed`];
    if (i < n) handoffMs += m[`p${i + 1}.start`] - m[`p${i}.hiddenDone`];
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const wallMs = sum(windowsMs); const runWallMs = m['run.end'] - m['run.start'];
  const split = { setupMs: m['p1.start'] - m['run.start'], lagMs: sum(lagByPhaseMs), verificationMs, handoffMs, accountingMs: m['accounting.done'] - m[`p${n}.hiddenDone`], teardownMs: m['run.end'] - m['accounting.done'], residualMs: 0 };
  split.residualMs = runWallMs - (wallMs + split.setupMs + split.lagMs + split.verificationMs + split.handoffMs + split.accountingMs + split.teardownMs);
  return { fairTiming: true, graded: 'fairWallMs', wallMs, runWallMs, windowsMs, observedSumMs, overheadMs: runWallMs - wallMs, split, lagByPhaseMs };
}

/**
 * Condition-based wait (replaces the fixed accounting sleep): call `read()` (returns a JSON-able snapshot) every `intervalMs` until two CONSECUTIVE snapshots are identical
 * and `isReady(snapshot)` holds, or `deadlineMs` elapses. Bounded; never sleeps without re-reading; the outcome is recorded, never assumed.
 * @returns {Promise<{snapshot:any, polls:number, waitedMs:number, settled:boolean, deadlineHit:boolean}>}
 */
export async function waitUntilStable(read, { intervalMs = 50, deadlineMs = 5000, isReady = () => true, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now(); let prev = null; let polls = 0; let snap = null;
  for (;;) {
    snap = await read(); polls++;
    const key = JSON.stringify(snap);
    if (prev !== null && key === prev && isReady(snap)) return { snapshot: snap, polls, waitedMs: now() - t0, settled: true, deadlineHit: false };
    prev = key;
    if (now() - t0 >= deadlineMs) return { snapshot: snap, polls, waitedMs: now() - t0, settled: false, deadlineHit: true };
    await sleep(intervalMs);
  }
}
