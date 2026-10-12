// PARITY-INSTRUMENT-ONLY
// R5-scorefix AC5: OFFLINE rescore of a finished round's records under the corrected scorers. Zero model calls, zero judge calls, no live run.
// Reads <round>/live/out/runs/<id>/record.json (never written), recomputes the two inputs the scorer fix changed from data already in the record
// (x2_parallel's overlap from metrics.phases[0].children via intendedPairOverlap; c1_cache's gapSeconds from the rep-1 record's finishedAt to this record's
// startedAt), re-scores the stored observation, and writes the result to a NEW directory laid out like a round (<out>/live/out/runs/<id>/record.json,
// judge dirs copied) so `renderReport` produces the verdict and the grid from it.
//   node parity/rescore.mjs [--round R5] [--out DIR]       (default out = tmp/agent-mcp/parity/<round>/rescore)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import * as O from './oracle.mjs';
import * as F from './fixtures.mjs';
import { renderReport, tmpRoot } from './drive.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/**
 * Rescore ONE record. `prior` = the same arm's rep-1 record (for the rep-2 gap) or null. Pure: returns { obs, score, patched } and mutates nothing.
 * `patch:false` re-scores the stored observation untouched (the fidelity baseline: it must reproduce the stored score).
 */
export function rescoreRecord(record, prior, { patch = true } = {}) {
  const obs = clone(record.observation); const patched = {};
  if (patch) {
    const kids = (record.metrics?.phases?.[0]?.children ?? []).filter((c) => c.depth === 1);
    if (obs.dispatch?.p1Parallel && kids.length) {
      const pair = L.intendedPairOverlap(kids.map((c) => ({ id: c.id, createdAt: c.createdAt, completedAt: c.completedAt })));
      patched.x2 = { before: obs.dispatch.p1Parallel.overlapMs, after: pair.overlapMs, basis: pair.basis, rows: pair.group };
      obs.dispatch.p1Parallel = { ...obs.dispatch.p1Parallel, overlapMs: pair.overlapMs, pairBasis: pair.basis, pairRows: pair.group };
    }
    if (record.rep === 2 && prior?.finishedAt && record.startedAt) {
      const gap = Math.round((Date.parse(record.startedAt) - Date.parse(prior.finishedAt)) / 1000);
      patched.gapSeconds = { before: obs.cache?.gapSeconds ?? null, after: gap };
      obs.cache = { ...(obs.cache ?? {}), gapSeconds: gap };
    }
  }
  // record.expected drops `original` (the seeded repo files e1_dup_edit compares against); it is deterministic from the seed, so regenerate it and refuse to proceed if any stored value disagrees
  const regen = F.expectedOf(F.makeSpec({ seed: record.seed, arm: record.arm, rep: record.rep }));
  for (const k of Object.keys(record.expected ?? {})) if (k !== 'original' && JSON.stringify(record.expected[k]) !== JSON.stringify(regen[k])) throw new Error(`${record.runId}: regenerated expected.${k} differs from the stored value`);
  const expected = regen;
  return { obs, score: O.scoreObservation(obs, expected), patched };
}

const fieldsOf = (score) => Object.fromEntries(Object.entries(score.fields).map(([k, v]) => [k, { status: v.status, detail: v.detail ?? '' }]));
const copyDir = (src, dst) => { if (!fs.existsSync(src)) return; fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f)); };

export function rescoreRound({ round = 'R5', out } = {}) {
  const root = tmpRoot(round); const runs = path.join(root, 'live/out/runs'); out = out ?? path.join(root, 'rescore');
  const ids = fs.readdirSync(runs).filter((d) => fs.existsSync(path.join(runs, d, 'record.json'))).sort();
  const recs = Object.fromEntries(ids.map((id) => [id, readJson(path.join(runs, id, 'record.json'))]));
  const res = []; const table = []; const lines = [];
  for (const id of ids) {
    const rec = recs[id]; if (!rec.observation || !rec.score) { lines.push(`${id}: no scored observation (aborted or void), carried over unchanged`); fs.mkdirSync(path.join(out, 'live/out/runs', id), { recursive: true }); fs.writeFileSync(path.join(out, 'live/out/runs', id, 'record.json'), JSON.stringify(rec, null, 2)); continue; }
    const prior = rec.rep === 2 ? recs[`${rec.arm}1`] ?? null : null;
    const base = rescoreRecord(rec, prior, { patch: false });
    const baseDiff = Object.keys(rec.score.fields).filter((k) => JSON.stringify(rec.score.fields[k].status) !== JSON.stringify(base.score.fields[k]?.status));
    const r = rescoreRecord(rec, prior);
    const before = fieldsOf(rec.score), after = fieldsOf(r.score);
    const changed = Object.keys(after).filter((k) => before[k]?.status !== after[k].status);
    res.push({ id, baseDiff, changed });
    for (const k of Object.keys(after)) table.push({ id, item: k, before: before[k]?.status ?? '-', after: after[k].status, detail: after[k].detail });
    const dir = path.join(out, 'live/out/runs', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ ...rec, score: r.score, rescore: { by: 'R5-scorefix', source: path.join(runs, id, 'record.json'), patched: r.patched, flipped: changed, fidelityBaselineMismatch: baseDiff }, observation: { ...rec.observation, dispatch: r.obs.dispatch, cache: r.obs.cache } }, null, 2));
  }
  for (const d of ['judge', 'judge-rep2']) copyDir(path.join(root, d), path.join(out, d));
  // ---- text outputs
  const pad = (s, n) => String(s).padEnd(n);
  const items = [...new Set(table.map((t) => t.item))];
  const ids2 = [...new Set(table.map((t) => t.id))];
  const itemTable = [`per-item status, rescored (before -> after; * = changed)`, pad('item', 22) + ids2.map((i) => pad(i, 16)).join('')];
  for (const it of items) itemTable.push(pad(it, 22) + ids2.map((id) => { const t = table.find((x) => x.id === id && x.item === it); return pad(!t ? '' : t.before === t.after ? t.after : `${t.before}->${t.after}*`, 16); }).join(''));
  const counts = ['per-run counts (before -> after)'];
  for (const id of ids2) { const c = (k) => { const rows = table.filter((t) => t.id === id); const n = (s) => rows.filter((t) => t[k] === s).length; return `pass ${n('pass')} fail ${n('fail')} na ${n('na')} invalid ${n('invalid')}`; }; counts.push(`${pad(id, 4)} before: ${c('before')}   after: ${c('after')}`); }
  const diff = ['changed items (before -> after, reason from the scorer detail)'];
  for (const t of table.filter((x) => x.before !== x.after)) diff.push(`${t.id} ${t.item}: ${t.before} -> ${t.after}   ${t.detail}`);
  if (diff.length === 1) diff.push('(none)');
  const fidelity = ['fidelity baseline (re-score of the stored observation with NO patch, vs the stored score)'];
  for (const r of res) fidelity.push(`${r.id}: ${r.baseDiff.length ? 'MISMATCH ' + r.baseDiff.join(',') : 'identical'}`);
  fs.mkdirSync(out, { recursive: true });
  const write = (f, arr) => fs.writeFileSync(path.join(out, f), arr.join('\n') + '\n');
  write('items.txt', itemTable); write('counts.txt', counts); write('diff.txt', diff); write('fidelity.txt', [...fidelity, ...lines]);
  for (const rep of [1, 2]) for (const mode of ['verdict', 'grid']) fs.writeFileSync(path.join(out, `${mode}-rep${rep}.txt`), renderReport(out, rep, mode, round) + '\n');
  return { out, res, table };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const o = {};
  for (let i = 0; i < a.length; i++) { if (a[i] === '--round') o.round = a[++i]; else if (a[i] === '--out') o.out = path.resolve(a[++i]); else { console.error(`unknown argument ${a[i]}`); process.exit(2); } }
  const r = rescoreRound(o);
  console.log(`rescored ${r.res.length} records into ${r.out}`);
  const bad = r.res.filter((x) => x.baseDiff.length); if (bad.length) { console.error(`fidelity baseline mismatch: ${bad.map((x) => `${x.id}[${x.baseDiff}]`).join(' ')}`); process.exit(3); }
}
