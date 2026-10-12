// PARITY-INSTRUMENT-ONLY
// Round gate (R0.AC7, R0.AC8, R2.AC7). Pure functions; every gate fails closed (a throw is a red gate).
// Order (deviation from R0.AC8's literal [pacing, ledger, scope, preflight], see README "Gate order"): the read-only ledger check,
// then scope, then the judge-credential presence check (no model call, so a round cannot pay for arms it cannot score), then preflight (zero model calls, must not spawn `claude`), then pacing (spawns `claude /usage`), then reservation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const GATE_ORDER = Object.freeze(['ledger', 'scope', 'judgeCredential', 'preflight', 'pacing']);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * scenarioSha over prompts() + ticketText() + the fixtures expectations (R0.AC7).
 * @param {{prompts:{phase1:string,phase2:string}, ticketText:string, expectations:unknown}} parts
 */
export function scenarioSha({ prompts, ticketText, expectations }) {
  return sha256(JSON.stringify({ p1: prompts.phase1, p2: prompts.phase2, ticket: ticketText, expectations }));
}

/**
 * Resolve the EXPERIMENT-LOG path the scope gate must read. The LOG is owned by the main checkout; a worktree's own copy is stale.
 * `git rev-parse --git-common-dir` points at <main>/.git for every worktree, so its parent is the main checkout root. The main copy
 * wins when it exists; otherwise the worktree copy (`<repoRoot>/<rel>`) is used. `runGit` / `exists` are injectable for tests.
 */
export function resolveLogPath(repoRoot, rel = 'docs/agent/parity/EXPERIMENT-LOG.md', { runGit, exists = fs.existsSync } = {}) {
  const local = path.join(repoRoot, rel);
  const git = runGit ?? ((args) => { const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }); return r.status === 0 ? String(r.stdout).trim() : ''; });
  let common = ''; try { common = git(['rev-parse', '--git-common-dir']); } catch { common = ''; }
  if (!common) return local;
  const mainRoot = path.dirname(path.resolve(repoRoot, common));
  const main = path.join(mainRoot, rel);
  return exists(main) ? main : local;
}

/** Parse LOG `### ` headings into { id-text, date }. A heading's date is its leading ISO timestamp. */
export function parseLogHeadings(logText) {
  const out = [];
  for (const line of String(logText).split('\n')) {
    const m = /^###\s+(.*)$/.exec(line); if (!m) continue;
    const text = m[1].trim(); const d = /^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)/.exec(text);
    out.push({ text, date: d ? d[1] : null });
  }
  return out;
}

/**
 * Scope-change gate. When the scenario differs from the previous round's, every `scopeChanges[]` id must match a LOG heading
 * `### <id>` (id as a whole token in the heading) whose leading timestamp is before the round's `startedAt`.
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function checkScope({ scenarioSha: cur, previousSha, scopeChanges = [], logText = '', startedAt }) {
  if (!previousSha || previousSha === cur) return { ok: true, reasons: [] };
  const reasons = [];
  if (!scopeChanges.length) reasons.push(`scenarioSha changed (${String(previousSha).slice(0, 12)} -> ${cur.slice(0, 12)}) but ledger.scopeChanges is empty`);
  const heads = parseLogHeadings(logText); const started = Date.parse(startedAt);
  for (const id of scopeChanges) {
    const re = new RegExp(`(^|[^\\w-])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
    const h = heads.find((x) => re.test(x.text));
    if (!h) { reasons.push(`scope change ${id}: no "### ${id}" heading in the LOG`); continue; }
    if (!h.date || !Number.isFinite(Date.parse(h.date)) || !(Date.parse(h.date) < started)) reasons.push(`scope change ${id}: LOG heading is not dated before the round start ${startedAt}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Run the gates in GATE_ORDER; stop at the first red one. `gates` maps name -> () => {ok, reasons} | Promise.
 * A gate that throws, or returns a non-object, is red (fail closed). No gate may reserve a run; reservation happens after all pass.
 */
export async function runGates(gates) {
  const results = [];
  for (const name of GATE_ORDER) {
    const g = gates[name];
    let r;
    try { r = g ? await g() : { ok: false, reasons: [`gate ${name} is not wired`] }; } catch (e) { r = { ok: false, reasons: [`gate ${name} threw: ${String(e?.message || e).slice(0, 200)}`] }; }
    if (!r || typeof r.ok !== 'boolean') r = { ok: false, reasons: [`gate ${name} returned no verdict`] };
    results.push({ gate: name, ...r });
    if (!r.ok) return { ok: false, exitCode: 3, failed: name, results };
  }
  return { ok: true, exitCode: 0, failed: null, results };
}

/**
 * Void rule (section 3): arm A is a genuine success only if every content item passes, the run is not INVALID,
 * and it carries no defect signal. Anything else voids the iteration (B and C are not run, nothing enters the grid).
 * @param {{score?:{summary?:{content?:{pass:number,total:number},invalid?:number}}, invalidRun?:unknown, defectSignal?:unknown}} rec
 */
export function isGenuineSuccess(rec) {
  const c = rec?.score?.summary?.content;
  if (!c || !(c.total > 0) || c.pass !== c.total) return false;
  if ((rec.score.summary.invalid ?? 0) > 0) return false;
  if (rec.invalidRun && (!Array.isArray(rec.invalidRun) || rec.invalidRun.length)) return false;
  if (rec.defectSignal) return false;
  return true;
}
