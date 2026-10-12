// PARITY-INSTRUMENT-ONLY
// Metric model and verdict (R4). Pure. Each of B and C is compared to arm A of the SAME iteration.
// Goal metrics (gated): cost (billed, authoritative; common-card shown beside it) <= 1.02 x A, duration (wall) <= 1.02 x A,
// quality (R5 mean of 8) >= 0.98 x A. Report-only, NEVER gating: turns, tool calls, peak context.
// R9-meas (owner: "Report both (Recommended)"): `duration` stays the run WALL clock (record.wallMs, the graded metric). The PHASE SUM (sum of the phase intervals, harness
// setup/teardown/fixed sleeps excluded) is reported beside it in every verdict / grid / summary and NEVER gates; the harness overhead is broken out (durationBreakdown).
// Thresholds are function arguments, never an env switch. n=1 per arm: a fixed threshold, not a significance claim.

export const DEFAULT_THRESHOLDS = Object.freeze({ cost: 1.02, duration: 1.02, quality: 0.98 });
export const N1_NOTE = 'n=1 per arm; fixed threshold, no significance claim';

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

/** Cost / duration / report-only accessors over a run record (shape written by drive.mjs analyze). */
export function costBilled(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.costUsd?.authoritative ?? p.costUsd?.total); }
export function costCommonCard(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.costUsd?.total); }
export function durationMs(rec) { return rec?.wallMs ?? null; }

/** The fixed pause the driver takes between the last phase and the usage queries (`drive.mjs runArmBC`); the one constant of the harness overhead. */
export const ACCOUNTING_SLEEP_MS = 1500;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
/**
 * R9-meas AC1: the PHASE SUM = sum of `metrics.phases[].wallMs` (A: spawn -> exit of each `claude -p` turn; B/C: the first poll after the task is submitted -> the poll that saw a terminal
 * status, i.e. the phase interval as the driver observed it, client poll lag included). Null unless there is at least one phase and EVERY phase has a finite wallMs (never a partial sum).
 * A stored `record.duration.phaseSumMs` (a record written by R9+) wins, so a rederivation never silently re-sums.
 */
export function phaseSumMs(rec) {
  if (fin(rec?.duration?.phaseSumMs)) return rec.duration.phaseSumMs;
  const ph = rec?.metrics?.phases; if (!Array.isArray(ph) || ph.length === 0) return null;
  let t = 0; for (const p of ph) { if (!fin(p?.wallMs)) return null; t += p.wallMs; }
  return t;
}
/** Harness overhead = wall - phase sum (setup, submit, between-phase checks, fixed sleep, usage queries, teardown, analysis); null when either side is missing. */
export function harnessOverheadMs(rec) { const w = durationMs(rec); const p = phaseSumMs(rec); return fin(w) && fin(p) ? w - p : null; }

const tms = (c) => Date.parse(c?.t);
const callStart = (c) => tms(c) - (fin(c?.ms) ? c.ms : 0);
const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
/**
 * R9-meas AC1: the duration facts of ONE run, from timings already in the record (+ the run dir's `mcp-calls.json` for arms B/C, passed as `calls`).
 *   wallMs (graded, unchanged) | phaseSumMs | overheadMs = wall - phaseSum | overhead = the split of that gap.
 * B/C with a call log: setupMs (run start -> the first task submit), submitMs (the submit calls), betweenPhasesMs (phase N observed terminal -> phase N+1 submit: hidden suite + file reads),
 * accountingWaitMs (last phase terminal -> first usage query; fixedSleepMs = the driver's 1500 ms pause, hiddenAndReadsMs = the rest), queriesMs, teardownMs (last call -> wallMs: server close,
 * capture close, analysis); residualMs = whatever the clocks do not explain (0 when the log and the phase walls agree). The run start is `finishedAt - wallMs` (both written back to back).
 * Without a call log (arm A, or a B/C run whose log is gone) nothing is split: `{attributed:false, unattributedMs}`; an invented split would be worse than none.
 * Also reported (B/C, from the session's task_list rows): serverSumMs = sum of the root tasks' completedAt - createdAt, and pollLagMs = phaseSum - serverSum, the client poll lag that sits INSIDE the phase sum.
 * Pure; the record is not touched.
 */
export function durationBreakdown(rec, calls = null) {
  const wallMs = durationMs(rec); const ps = phaseSumMs(rec); const ov = harnessOverheadMs(rec);
  const out = { graded: 'wallMs', wallMs: fin(wallMs) ? wallMs : null, phaseSumMs: ps, overheadMs: ov, overhead: { attributed: false, unattributedMs: ov } };
  if (!Array.isArray(calls) || !calls.length || ov == null || !rec?.finishedAt) return out;
  const t0 = Date.parse(rec.finishedAt) - wallMs; if (!fin(t0)) return out;
  const phases = rec.metrics.phases; const taskCalls = calls.filter((c) => c?.name === 'task');
  const submitOf = (p, i) => taskCalls.find((c) => tryJson(c.text)?.task_id === p.taskId && p.taskId) ?? taskCalls[i];
  const subs = phases.map(submitOf);
  if (subs.some((c) => !c || !fin(tms(c)))) return out;
  const ends = phases.map((p, i) => { const rs = calls.filter((c) => c?.name === 'result' && c.args?.task_id === (p.taskId ?? tryJson(subs[i].text)?.task_id)); return rs.length ? Math.max(...rs.map(tms)) : null; });
  if (ends.some((e) => !fin(e))) return out;
  const lastEnd = ends[ends.length - 1];
  const acct = calls.filter((c) => (c?.name === 'usage_query' || c?.name === 'task_list') && tms(c) >= lastEnd);
  const callsEnd = Math.max(...calls.map(tms));
  const acctStart = acct.length ? Math.min(...acct.map(callStart)) : lastEnd;
  const o = { attributed: true, setupMs: callStart(subs[0]) - t0, submitMs: subs.reduce((a, c) => a + (fin(c.ms) ? c.ms : 0), 0), betweenPhasesMs: 0 };
  for (let i = 1; i < phases.length; i++) o.betweenPhasesMs += callStart(subs[i]) - ends[i - 1];
  o.accountingWaitMs = acctStart - lastEnd;
  o.fixedSleepMs = acct.length ? Math.min(ACCOUNTING_SLEEP_MS, o.accountingWaitMs) : 0;
  o.hiddenAndReadsMs = o.accountingWaitMs - o.fixedSleepMs;
  o.queriesMs = acct.length ? callsEnd - acctStart : 0;
  o.teardownMs = t0 + wallMs - Math.max(callsEnd, lastEnd);
  o.residualMs = ov - (o.setupMs + o.submitMs + o.betweenPhasesMs + o.accountingWaitMs + o.queriesMs + o.teardownMs);
  out.overhead = o;
  const list = calls.filter((c) => c?.name === 'task_list' && c.args?.session_id).map((c) => tryJson(c.text)).find(Array.isArray);
  if (list) {
    const rows = phases.map((p) => list.find((r) => r?.id === p.taskId)); const iv = rows.map((r) => (r ? Date.parse(r.completedAt) - Date.parse(r.createdAt) : NaN));
    if (iv.every(fin)) { out.serverSumMs = iv.reduce((a, b) => a + b, 0); out.pollLagMs = ps - out.serverSumMs; }
  }
  return out;
}

const ratioOf = (x, a) => (fin(x) && fin(a) && a > 0 ? x / a : null);
/**
 * R9-meas AC1: both duration metrics for a set of run records `{A?,B?,C?}` and the B/A, C/A ratios under each (null without arm A). `calls` = optional `{arm: callLog}`.
 * Read-only over its inputs. wall is the graded metric; phase-sum is report-only.
 */
export function rederiveDurations(recsByArm, callsByArm = {}) {
  const arms = {}; for (const [arm, rec] of Object.entries(recsByArm)) arms[arm] = { runId: rec.runId ?? null, ...durationBreakdown(rec, callsByArm[arm] ?? null) };
  const ratios = {}; for (const arm of Object.keys(arms)) if (arm !== 'A') ratios[arm] = { wall: ratioOf(arms[arm].wallMs, arms.A?.wallMs), phaseSum: ratioOf(arms[arm].phaseSumMs, arms.A?.phaseSumMs) };
  return { arms, ratios };
}
const sec = (ms) => (fin(ms) ? (ms / 1000).toFixed(3) : 'n/a');
const r3 = (x) => (fin(x) ? x.toFixed(3) : 'n/a');
/** Printable table for `drive.mjs --rederive-duration`: both metrics side by side, wall labelled graded, then the overhead split per run and the ratios. */
export function formatDurationTable(rd) {
  const L = ['run | wall (graded) ms | phase-sum (report-only) ms | harness overhead ms'];
  for (const [arm, a] of Object.entries(rd.arms)) L.push(`${a.runId ?? arm} | ${a.wallMs ?? 'n/a'} | ${a.phaseSumMs ?? 'n/a'} | ${a.overheadMs ?? 'n/a'}`);
  for (const [arm, r] of Object.entries(rd.ratios)) L.push(`${arm}/A | wall (graded) ${r3(r.wall)} | phase-sum (report-only) ${r3(r.phaseSum)}`);
  for (const [arm, a] of Object.entries(rd.arms)) {
    const o = a.overhead; if (!o) continue;
    if (!o.attributed) { L.push(`${a.runId ?? arm} overhead: unattributed ${sec(o.unattributedMs)} s (no call log; not split)`); continue; }
    L.push(`${a.runId ?? arm} overhead s: setup ${sec(o.setupMs)}, submit ${sec(o.submitMs)}, between phases ${sec(o.betweenPhasesMs)}, accounting wait ${sec(o.accountingWaitMs)} (fixed sleep ${sec(o.fixedSleepMs)} + hidden suite/reads ${sec(o.hiddenAndReadsMs)}), usage queries ${sec(o.queriesMs)}, teardown+analysis ${sec(o.teardownMs)}, residual ${sec(o.residualMs)}`
      + (fin(a.pollLagMs) ? ` | inside the phase sum: client poll lag ${sec(a.pollLagMs)} s (server-side task intervals sum to ${sec(a.serverSumMs)} s)` : ''));
  }
  return L.join('\n');
}
export function turnsOf(rec) { return sum(rec?.metrics?.phases ?? [], (p) => (p.turns?.parent || 0) + (p.turns?.child || 0)); }
export function toolCallsOf(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.calls?.total); }
/** Report-only thinking turns observed in the run (record.thinking.observedThinkingTurns, max of parent turns and all tasks); null when the record carries none. Never gating (R7-think AC1). */
export function thinkingTurnsOf(rec) { const n = rec?.thinking?.observedThinkingTurns; return Number.isFinite(n) ? n : null; }
/** R6-prep AC3: peak context = max over phases of `phases[].tokens.total.ctx` (the field drive.mjs actually writes: max per-turn in+cache over parent and child turns). The old names are kept as fallbacks. */
export function peakContextOf(rec) { const v = (rec?.metrics?.phases ?? []).map((p) => p.tokens?.total?.ctx ?? p.peakContext ?? p.context?.peak ?? p.tokens?.peakCtx).filter(Number.isFinite); return v.length ? Math.max(...v) : null; }

/** Normalize a record into the summary the verdict consumes. `genuine` and `quality` are supplied by the gate/judge. */
export function summarize(rec, { genuine, quality = null } = {}) {
  return { runId: rec.runId, arm: rec.arm ?? String(rec.runId)[0], genuine: genuine === true, extra: !!rec.extra, extraRunReason: rec.extraRunReason ?? '',
    costBilled: costBilled(rec), costCommon: costCommonCard(rec), wallMs: durationMs(rec), phaseSumMs: phaseSumMs(rec), quality, turns: turnsOf(rec), toolCalls: toolCallsOf(rec), peakContext: peakContextOf(rec), thinkingTurns: thinkingTurnsOf(rec) };
}

const ratio = (x, a) => (Number.isFinite(x) && Number.isFinite(a) && a > 0 ? x / a : null);
const gate = (r, limit, dir) => (r == null ? 'n/a' : (dir === 'max' ? r <= limit : r >= limit) ? 'PASS' : 'FAIL');

/**
 * Verdict for one variant against A. A not genuinely successful => VOID, no ratios (R4.AC3).
 * A variant that is not a genuine success is FAIL on correctness regardless of ratios (one red variant makes the round red).
 * An extra run (run 4+) is EXCLUDED unless its extraRunReason is set (R4.AC7).
 */
export function variantVerdict(A, X, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (!A || A.genuine !== true) return { arm: X?.arm, verdict: 'VOID', reason: 'arm A did not genuinely succeed; the iteration is void and unscored', note: N1_NOTE };
  if (X.extra && !String(X.extraRunReason).trim()) return { arm: X.arm, verdict: 'EXCLUDED', reason: 'extra run without extraRunReason', note: N1_NOTE };
  const cost = ratio(X.costBilled, A.costBilled); const dur = ratio(X.wallMs, A.wallMs); const q = ratio(X.quality, A.quality);
  const durPhaseSum = { ratio: ratio(X.phaseSumMs, A.phaseSumMs), gating: false, basis: 'sum of phases[].wallMs; reported beside the graded wall duration, never a pass bar (R9-meas)' };
  const goals = { cost: { ratio: cost, limit: t.cost, result: gate(cost, t.cost, 'max') }, duration: { ratio: dur, limit: t.duration, result: gate(dur, t.duration, 'max') }, quality: { ratio: q, limit: t.quality, result: gate(q, t.quality, 'min') } };
  const reportOnly = { turns: { arm: X.turns, A: A.turns }, toolCalls: { arm: X.toolCalls, A: A.toolCalls }, peakContext: { arm: X.peakContext, A: A.peakContext }, thinkingTurns: { arm: X.thinkingTurns ?? null, A: A.thinkingTurns ?? null } };
  const commonCard = { ratio: ratio(X.costCommon, A.costCommon) };
  const gated = Object.values(goals).map((g) => g.result);
  const verdict = !X.genuine ? 'FAIL' : gated.includes('FAIL') ? 'FAIL' : 'PASS';
  return { arm: X.arm, verdict, correctness: X.genuine ? 'PASS' : 'FAIL', goals, commonCard, durationPhaseSum: durPhaseSum, reportOnly, note: N1_NOTE };
}

/** Round verdict over { A, B, C } summaries: PASS only if every variant is PASS; VOID if A is void. */
export function roundVerdict(sums, thresholds = DEFAULT_THRESHOLDS) {
  const variants = ['B', 'C'].filter((k) => sums[k]).map((k) => variantVerdict(sums.A, sums[k], thresholds));
  const void_ = !sums.A || sums.A.genuine !== true;
  return { verdict: void_ ? 'VOID' : variants.every((v) => v.verdict === 'PASS') ? 'PASS' : 'FAIL', variants, note: N1_NOTE };
}

const pct = (r) => (r == null ? 'n/a' : `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%`);
/** Printable verdict table for `drive.mjs verdict --round R<n>`. */
export function formatVerdict(rv) {
  const lines = [`ROUND ${rv.verdict}  (${rv.note})`];
  for (const v of rv.variants) {
    if (v.verdict === 'VOID' || v.verdict === 'EXCLUDED') { lines.push(`${v.arm}: ${v.verdict} ${v.reason}`); continue; }
    const g = v.goals;
    lines.push(`${v.arm}: ${v.verdict} | cost ${g.cost.ratio?.toFixed(3) ?? 'n/a'} ${g.cost.result} (common-card ${v.commonCard.ratio?.toFixed(3) ?? 'n/a'}) | duration wall (graded) ${g.duration.ratio?.toFixed(3) ?? 'n/a'} ${g.duration.result}, phase-sum (report-only) ${v.durationPhaseSum?.ratio?.toFixed(3) ?? 'n/a'} | quality ${g.quality.ratio?.toFixed(3) ?? 'n/a'} ${g.quality.result}`
      + ` | report-only turns ${v.reportOnly.turns.arm}/${v.reportOnly.turns.A}, tool calls ${v.reportOnly.toolCalls.arm}/${v.reportOnly.toolCalls.A}, peak ctx ${v.reportOnly.peakContext.arm ?? 'n/a'}/${v.reportOnly.peakContext.A ?? 'n/a'}, thinking turns ${v.reportOnly.thinkingTurns?.arm ?? 'n/a'}/${v.reportOnly.thinkingTurns?.A ?? 'n/a'}`);
  }
  return lines.join('\n');
}
export { pct };

/**
 * Per-run duration decomposition (R4.AC5) from normalized call timings:
 * [{ phase, kind:'model'|'tool', startMs, endMs, ttfbMs? }] relative to run start.
 */
export function decomposeDuration(calls) {
  const model = calls.filter((c) => c.kind === 'model'); const tool = calls.filter((c) => c.kind === 'tool');
  const dur = (c) => Math.max(0, c.endMs - c.startMs);
  const byPhase = {};
  for (const c of calls) { const p = (byPhase[c.phase ?? 0] ??= { modelMs: 0, toolMs: 0 }); p[c.kind === 'model' ? 'modelMs' : 'toolMs'] += dur(c); }
  return { timeToFirstModelEventMs: model.length ? Math.min(...model.map((c) => (c.ttfbMs != null ? c.startMs + c.ttfbMs : c.startMs))) : null,
    summedModelMs: model.reduce((a, c) => a + dur(c), 0), summedToolMs: tool.reduce((a, c) => a + dur(c), 0), byPhase,
    perCallTtfbMs: model.map((c) => c.ttfbMs ?? null) };
}
