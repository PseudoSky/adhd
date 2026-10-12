// PARITY-INSTRUMENT-ONLY
// Grid and report (R7). Pure rendering of the LOG section-2 row: icon + content score per arm, and the per-arm metric line.

/** Content score "pass/total" from a run record, or null when there is no score yet. */
export function contentScore(rec) {
  const c = rec?.score?.summary?.content;
  return c && Number.isFinite(c.pass) && Number.isFinite(c.total) && c.total > 0 ? { pass: c.pass, total: c.total } : null;
}

/**
 * One grid cell (R7.AC1).
 * record.state: 'not_started' | 'running' | 'void' | 'done' (default 'done' when a score exists).
 *   void -> `VOID`; not started -> ⚪; running -> 🟡 (+ partial score); invalid -> `⛔ n/a`;
 *   done -> 🟢 n/n when every content item passed, else 🔴 p/n; a defect-signal variant is 🔴 even if every item passed.
 */
export function renderGridCell(rec) {
  const state = rec?.state ?? (rec ? 'done' : 'not_started');
  if (state === 'void') return 'VOID';
  if (state === 'not_started' || !rec) return '⚪';
  const s = contentScore(rec); const frac = s ? `${s.pass}/${s.total}` : null;
  if (state === 'running') return frac ? `🟡 ${frac}` : '🟡';
  const invalid = (rec.score?.summary?.invalid ?? 0) > 0 || (Array.isArray(rec.invalidRun) ? rec.invalidRun.length > 0 : !!rec.invalidRun);
  if (invalid) return '⛔ n/a';
  if (!s) return '⛔ n/a';
  if (rec.defectSignal) return `🔴 ${frac}`;
  return s.pass === s.total ? `🟢 ${frac}` : `🔴 ${frac}`;
}

/** The LOG section-2 row: cells joined with ` | ` in the given order (default A, B, C). */
export function renderGridRow(recordsByArm, order = ['A', 'B', 'C']) { return order.map((a) => renderGridCell(recordsByArm[a])).join(' | '); }

const pct = (r) => (r == null || !Number.isFinite(r) ? 'n/a' : `${r >= 1 ? '+' : '-'}${Math.abs((r - 1) * 100).toFixed(0)}%`);
/** Per-arm metric line `cost +x% / dur +y% / Q z% / peak ctx Nk vs A Mk` from an R4 variantVerdict (R7.AC3). Q is the quality ratio as a percent of A. */
export function renderMetricLine(v) {
  if (!v || v.verdict === 'VOID') return 'VOID';
  if (v.verdict === 'EXCLUDED') return 'EXCLUDED';
  const q = v.goals.quality.ratio;
  const k = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : 'n/a');
  const tt = v.reportOnly?.thinkingTurns;   // R7-think AC1: report-only thinking turns (this arm / A), never gating
  const pc = v.reportOnly?.peakContext;   // R6-prep AC3: report-only peak context (this arm / A), never gating
  return `cost ${pct(v.goals.cost.ratio)} / dur ${pct(v.goals.duration.ratio)} / Q ${q == null ? 'n/a' : `${Math.round(q * 100)}%`}${pc ? ` / peak ctx ${k(pc.arm)} vs A ${k(pc.A)}` : ''}${tt ? ` / thinking turns ${tt.arm ?? 'n/a'} vs A ${tt.A ?? 'n/a'}` : ''}`;
}

/** Full `grid --round` text: the row plus a metric line per variant. */
export function renderGrid(recordsByArm, roundVerdictObj, order = ['A', 'B', 'C']) {
  const lines = [renderGridRow(recordsByArm, order)];
  for (const v of roundVerdictObj?.variants ?? []) lines.push(`${v.arm}: ${renderMetricLine(v)}`);
  return lines.join('\n');
}
