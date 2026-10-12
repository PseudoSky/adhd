// PARITY-INSTRUMENT-ONLY
// Quality rubric, judge-output parser and aggregator (R5.AC3, AC4). Pure: no network, no model call.
// Quality is the unweighted mean of the 8 scores; the gate is arm mean >= 0.98 x A's mean on the same run; per-quality scores are reported, never gated.

export const RUBRIC = Object.freeze(['spec_conformance', 'code_clarity', 'change_discipline', 'verification', 'docs_quality', 'reasoning_soundness', 'transcript_focus', 'report_fidelity']);
export const RUBRIC_TEXT = Object.freeze({
  spec_conformance: 'code does what the task spec requires, including edge cases it names',
  code_clarity: 'readability, naming, structure',
  change_discipline: 'minimal, in-scope diff; no collateral edits',
  verification: 'tests run and not weakened; claims checked',
  docs_quality: 'shipping doc, CHANGELOG entry, usage examples are accurate and useful',
  reasoning_soundness: 'transcript: root cause found by evidence, sound decomposition and delegation',
  transcript_focus: 'no thrash, repeated dead ends, or redundant exploration',
  report_fidelity: 'final summary claims match the artifacts',
});
export const QUALITY_GATE = 0.98;

export class JudgeOutputError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.name = 'JudgeOutputError'; this.code = code; } }

/** Keys of the flat object that follows `"<name>"` in raw JSON text (for duplicate detection; JSON.parse silently keeps the last). */
function rawKeys(text, name) {
  const at = text.search(new RegExp(`"${name}"\\s*:\\s*\\{`)); if (at < 0) return [];
  const open = text.indexOf('{', at); let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < text.length; i++) { const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i; break; } }
  const body = text.slice(open + 1, end < 0 ? undefined : end);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
}

/**
 * R5-judge AC1: accept EXACTLY ONE surrounding markdown code fence (opening "```" or "```json", closing "```") around the reply and nothing else outside it.
 * Returns the trimmed inner text, or the input unchanged when it is not a complete single fence (so an unclosed fence, prose around a fence, or a second fence still fail downstream).
 */
function unfence(t) {
  const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/.exec(t);
  if (!m || m[1].includes('```')) return t;
  return m[1].trim();
}

/** True when `t` (starting with "{") has a complete balanced top-level object followed by more non-whitespace text (e.g. two objects). */
function secondValueFollows(t) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) return t.slice(i + 1).trim().length > 0;
  }
  return false;
}

/**
 * Parse the judge's raw reply. Contract: ONE JSON object (optionally inside exactly one code fence, R5-judge AC1) { scores: {<8 keys>: int 1-100}, notes: {<8 keys>: string} } and nothing else.
 * Rejects with a distinct JudgeOutputError.code: NOT_JSON, TEXT_OUTSIDE_JSON, BAD_SHAPE, MISSING_KEY, EXTRA_KEY, DUPLICATE_KEY, NON_INTEGER, OUT_OF_RANGE.
 * @returns {{scores:Record<string,number>, notes:Record<string,string>}}
 */
export function parseJudgeOutput(raw, _mutant) {
  const text = String(raw);
  // `_mutant` is TEST-ONLY (negative controls, R5-judge AC2): 'no-fence' removes the fence tolerance, 'wide' widens it to also accept prose around the JSON. Production callers never pass it.
  const t = _mutant === 'no-fence' ? text.trim() : _mutant === 'wide' ? (text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) || text.trim()) : unfence(text.trim());
  if (!t.startsWith('{') || !t.endsWith('}')) { let probe = false; try { JSON.parse(t); probe = true; } catch { /* below */ } throw new JudgeOutputError(probe || /\{[\s\S]*\}/.test(t) ? 'TEXT_OUTSIDE_JSON' : 'NOT_JSON', 'the reply must be exactly one JSON object'); }
  let obj; try { obj = JSON.parse(t); } catch (e) { throw new JudgeOutputError(secondValueFollows(t) ? 'TEXT_OUTSIDE_JSON' : 'NOT_JSON', secondValueFollows(t) ? 'more than one JSON value in the reply' : e.message); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.scores !== 'object' || obj.scores === null || Array.isArray(obj.scores) || typeof obj.notes !== 'object' || obj.notes === null || Array.isArray(obj.notes)) throw new JudgeOutputError('BAD_SHAPE', 'need { "scores": {...}, "notes": {...} }');
  for (const part of ['scores', 'notes']) {
    const keys = rawKeys(t, part); const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new JudgeOutputError('DUPLICATE_KEY', `${part}.${dup} appears more than once`);
    const got = Object.keys(obj[part]);
    const missing = RUBRIC.filter((k) => !got.includes(k)); if (missing.length) throw new JudgeOutputError('MISSING_KEY', `${part} is missing ${missing.join(', ')}`);
    const extra = got.filter((k) => !RUBRIC.includes(k)); if (extra.length) throw new JudgeOutputError('EXTRA_KEY', `${part} has unexpected ${extra.join(', ')}`);
  }
  if (Object.keys(obj).some((k) => k !== 'scores' && k !== 'notes')) throw new JudgeOutputError('EXTRA_KEY', 'unexpected top-level key');
  for (const k of RUBRIC) {
    const v = obj.scores[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new JudgeOutputError('NON_INTEGER', `scores.${k} must be an integer`);
    if (v < 1 || v > 100) throw new JudgeOutputError('OUT_OF_RANGE', `scores.${k}=${v} is outside 1..100`);
    if (typeof obj.notes[k] !== 'string') throw new JudgeOutputError('BAD_SHAPE', `notes.${k} must be a string`);
  }
  return { scores: Object.fromEntries(RUBRIC.map((k) => [k, obj.scores[k]])), notes: Object.fromEntries(RUBRIC.map((k) => [k, obj.notes[k]])) };
}

/** Unweighted mean of the 8 scores. */
export function qualityMean(scores) { return RUBRIC.reduce((a, k) => a + scores[k], 0) / RUBRIC.length; }

/**
 * Aggregate: ratio = arm mean / A mean (same run); result PASS iff ratio >= gate. A null mean (no judge call: void or red arm) is 'n/a'.
 * Per-quality scores are always reported, never gated.
 */
export function aggregateQuality(armScores, aScores, gate = QUALITY_GATE) {
  if (!armScores || !aScores) return { mean: armScores ? qualityMean(armScores) : null, aMean: aScores ? qualityMean(aScores) : null, ratio: null, result: 'n/a', perQuality: armScores ?? null };
  const mean = qualityMean(armScores); const aMean = qualityMean(aScores); const ratio = mean / aMean;
  return { mean, aMean, ratio, result: ratio >= gate ? 'PASS' : 'FAIL', perQuality: armScores };
}
