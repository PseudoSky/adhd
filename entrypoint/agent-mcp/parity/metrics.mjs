// PARITY-INSTRUMENT-ONLY
// Metric model and verdict (R4). Pure. Each of B and C is compared to arm A of the SAME iteration.
// Goal metrics (gated): cost (billed, authoritative; common-card shown beside it) <= 1.02 x A, duration (wall) <= 1.02 x A,
// quality (R5 mean of 8) >= 0.98 x A. Report-only, NEVER gating: turns, tool calls, peak context.
// Thresholds are function arguments, never an env switch. n=1 per arm: a fixed threshold, not a significance claim.

export const DEFAULT_THRESHOLDS = Object.freeze({ cost: 1.02, duration: 1.02, quality: 0.98 });
export const N1_NOTE = 'n=1 per arm; fixed threshold, no significance claim';

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

/** Cost / duration / report-only accessors over a run record (shape written by drive.mjs analyze). */
export function costBilled(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.costUsd?.authoritative ?? p.costUsd?.total); }
export function costCommonCard(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.costUsd?.total); }
export function durationMs(rec) { return rec?.wallMs ?? null; }
export function turnsOf(rec) { return sum(rec?.metrics?.phases ?? [], (p) => (p.turns?.parent || 0) + (p.turns?.child || 0)); }
export function toolCallsOf(rec) { return sum(rec?.metrics?.phases ?? [], (p) => p.calls?.total); }
export function peakContextOf(rec) { const v = (rec?.metrics?.phases ?? []).map((p) => p.peakContext ?? p.context?.peak ?? p.tokens?.peakCtx).filter(Number.isFinite); return v.length ? Math.max(...v) : null; }

/** Normalize a record into the summary the verdict consumes. `genuine` and `quality` are supplied by the gate/judge. */
export function summarize(rec, { genuine, quality = null } = {}) {
  return { runId: rec.runId, arm: rec.arm ?? String(rec.runId)[0], genuine: genuine === true, extra: !!rec.extra, extraRunReason: rec.extraRunReason ?? '',
    costBilled: costBilled(rec), costCommon: costCommonCard(rec), wallMs: durationMs(rec), quality, turns: turnsOf(rec), toolCalls: toolCallsOf(rec), peakContext: peakContextOf(rec) };
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
  const goals = { cost: { ratio: cost, limit: t.cost, result: gate(cost, t.cost, 'max') }, duration: { ratio: dur, limit: t.duration, result: gate(dur, t.duration, 'max') }, quality: { ratio: q, limit: t.quality, result: gate(q, t.quality, 'min') } };
  const reportOnly = { turns: { arm: X.turns, A: A.turns }, toolCalls: { arm: X.toolCalls, A: A.toolCalls }, peakContext: { arm: X.peakContext, A: A.peakContext } };
  const commonCard = { ratio: ratio(X.costCommon, A.costCommon) };
  const gated = Object.values(goals).map((g) => g.result);
  const verdict = !X.genuine ? 'FAIL' : gated.includes('FAIL') ? 'FAIL' : 'PASS';
  return { arm: X.arm, verdict, correctness: X.genuine ? 'PASS' : 'FAIL', goals, commonCard, reportOnly, note: N1_NOTE };
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
    lines.push(`${v.arm}: ${v.verdict} | cost ${g.cost.ratio?.toFixed(3) ?? 'n/a'} ${g.cost.result} (common-card ${v.commonCard.ratio?.toFixed(3) ?? 'n/a'}) | duration ${g.duration.ratio?.toFixed(3) ?? 'n/a'} ${g.duration.result} | quality ${g.quality.ratio?.toFixed(3) ?? 'n/a'} ${g.quality.result}`
      + ` | report-only turns ${v.reportOnly.turns.arm}/${v.reportOnly.turns.A}, tool calls ${v.reportOnly.toolCalls.arm}/${v.reportOnly.toolCalls.A}, peak ctx ${v.reportOnly.peakContext.arm ?? 'n/a'}/${v.reportOnly.peakContext.A ?? 'n/a'}`);
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
