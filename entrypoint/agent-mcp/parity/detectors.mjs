// PARITY-INSTRUMENT-ONLY
// Run detectors (pure). A "call" is { id, tool, args?, argsKey?, isError, text }.
//   egressSilentEmpty  (R2.AC8): a web result that is blank with isError false => w1_web INVALID(egress), with call ids.
//   toolErrorSignal    (R6): repeated tool errors => DEFECT_SIGNAL, read as a probable test or code bug (never "model failure").
// R6 thresholds are a PROPOSAL, not derived from repo data (R6.AC1); they are function arguments.

const WEB_TOOL = /(^|__)(web_fetch|web_search|WebFetch|WebSearch)$/;
const SHELL_TOOL = /(^|__)(Bash|shell_execute|shell)$/;
const WEB_SHELL_CMD = /\b(curl|wget)\b/;

const argsText = (c) => { try { return typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? ''); } catch { return ''; } };
/** Blank = no text at all, or an MCP content array whose text items are all blank (C stores results as the JSON of the content array). A MISSING result (null) is handled by the callers: it is unknown, not silent-empty. */
const blank = (t) => {
  const s = String(t).trim();
  if (s.replace(/\s+/g, '') === '') return true;
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.every((b) => b && typeof b === 'object' && (b.type === 'text' || b.type == null) ? String(b.text ?? '').trim() === '' : false); } catch { /* not JSON: real text */ } }
  return false;
};

/** True when the call is a web result of any arm: a shipped fetch/search tool, or a shell fetch (curl/wget). */
export function isWebCall(c) {
  if (WEB_TOOL.test(String(c.tool))) return true;
  return SHELL_TOOL.test(String(c.tool)) && WEB_SHELL_CMD.test(argsText(c));
}

/**
 * @param {Array<{id:string,tool:string,args?:unknown,isError:boolean,text?:string}>} calls
 * @returns {{detector:'egress-silent-empty', flagged:boolean, callIds:string[], w1_web:'INVALID(egress)'|null}}
 */
export function egressSilentEmpty(calls) {
  // isError === false AND a captured (non-null) result: a call whose result was never captured is unknown, never silent-empty.
  const ids = calls.filter((c) => isWebCall(c) && c.isError === false && c.text != null && blank(c.text)).map((c) => c.id);
  return { detector: 'egress-silent-empty', flagged: ids.length > 0, callIds: ids, w1_web: ids.length ? 'INVALID(egress)' : null };
}

/** Normalize args so retries of "the same call" collapse: digits, uuids and long hex collapse; key order is stable. */
export function normalizeArgs(c) {
  if (typeof c.argsKey === 'string') return c.argsKey;
  const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);
  let s; try { s = JSON.stringify(canon(c.args ?? null)); } catch { s = String(c.args); }
  return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>').replace(/\d+/g, '<n>');
}

export const TOOL_ERROR_DEFAULTS = Object.freeze({ sameToolMin: 3, rateMin: 0.25, rateMinCalls: 8 });

/**
 * Flag DEFECT_SIGNAL when the same tool with normalized args errors >= sameToolMin times, or the error rate is > rateMin over >= rateMinCalls calls.
 * @returns {{detector:'tool-errors', defectSignal:boolean, verdict:'DEFECT_SIGNAL'|'OK', callIds:string[], reasons:string[], text:string|null}}
 */
export function toolErrorSignal(calls, thresholds = {}) {
  const t = { ...TOOL_ERROR_DEFAULTS, ...thresholds };
  const errs = calls.filter((c) => c.isError);
  const reasons = []; const ids = new Set();
  const groups = new Map();
  for (const c of errs) { const k = `${c.tool}|${normalizeArgs(c)}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(c.id); }
  for (const [k, g] of groups) if (g.length >= t.sameToolMin) { reasons.push(`${k.split('|')[0]} errored ${g.length}x with the same normalized args`); g.forEach((i) => ids.add(i)); }
  if (calls.length >= t.rateMinCalls && errs.length / calls.length > t.rateMin) { reasons.push(`${errs.length}/${calls.length} tool calls errored (> ${Math.round(t.rateMin * 100)}%)`); errs.forEach((c) => ids.add(c.id)); }
  const defectSignal = reasons.length > 0;
  return { detector: 'tool-errors', defectSignal, verdict: defectSignal ? 'DEFECT_SIGNAL' : 'OK', callIds: [...ids], reasons,
    text: defectSignal ? `DEFECT_SIGNAL: suspect a test or code bug (${reasons.join('; ')}); call ids: ${[...ids].join(', ')}` : null };
}

/** Run every detector over a run's calls. analyze() calls this; a detector that throws is a red result, never skipped. */
export function runDetectors(calls, thresholds) {
  const out = [];
  for (const d of [() => egressSilentEmpty(calls), () => toolErrorSignal(calls, thresholds)]) {
    try { out.push(d()); } catch (e) { out.push({ detector: 'error', defectSignal: true, verdict: 'DEFECT_SIGNAL', callIds: [], reasons: [String(e?.message || e)], text: 'DEFECT_SIGNAL: a detector failed' }); }
  }
  return out;
}
