#!/usr/bin/env node
/**
 * test-routing — this repository's routing command and rigor checker (595965cc T43).
 *
 *   route         class + write scope + asserted triggers  ->  { rigor, triggers, authorship, playbook, gates }
 *   check         the recorded rigor against the derived rigor (G12), for one record file or a commit range
 *   distribution  the derived-rigor distribution over the last N merged changes (STRATEGY 6.6, D24)
 *
 * It encodes STRATEGY 6.6 (rigor derivation) and 6.7 (class applicability). The trigger ids, their
 * minimum rigor and their path globs, the distribution window, and the enforcement date are read from
 * the IMPLEMENTATION (`docs/standards/testing.md`), never held here, so changing a trigger is an edit
 * to one document. It never relaxes a gate: G1, G2, G4 and G12 are in every output.
 *
 * Exit: 0 ok · 1 the check failed or the change is inconsistent · 3 Deep refused (no coordinator or no
 * test author) · 64 usage · 65 unknown class, trigger or unreadable input.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../lib/git-env.js');

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../../..');
export const DEFAULT_IMPLEMENTATION = path.join(REPO_ROOT, 'docs', 'standards', 'testing.md');

export const RIGORS = ['none', 'light', 'standard', 'deep'];
const rank = (r) => RIGORS.indexOf(r);
const maxRigor = (a, b) => (rank(a) >= rank(b) ? a : b);

/** STRATEGY 6.7: default rigor and the author card per class (the card names are the harness's). */
export const CLASSES = {
  'new-behavior': { rigor: 'standard', playbook: 'author-new-behavior' },
  'defect-fix': { rigor: 'standard', playbook: 'author-regression' },
  refactor: { rigor: 'light', playbook: 'characterize' },
  configuration: { rigor: 'light', playbook: 'select-checks' },
  dependency: { rigor: 'light', playbook: 'select-checks' },
  'boundary-contract': { rigor: 'deep', playbook: 'author-contract' },
  'no-code': { rigor: 'none', playbook: 'none' },
  'test-maintenance': { rigor: 'standard', playbook: 'maintain' },
};

/** Gates every change carries whatever its class or rigor (STRATEGY 6.7); G10 joins when an artifact ships. */
export const NEVER_RELAXED = ['G1', 'G2', 'G4', 'G12'];

class UsageError extends Error {
  constructor(message, exit = 64) { super(message); this.exit = exit; }
}

// ---------------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------------

/** `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------------------------
// The IMPLEMENTATION: trigger table, window, enforcement date
// ---------------------------------------------------------------------------------------------

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** Trigger rows of the first table whose header names `id`, `minimum rigor` and `path patterns`. */
export function parseTriggers(md) {
  const lines = String(md ?? '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = splitRow(lines[i]);
    const sep = splitRow(lines[i + 1]);
    if (!header || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    const cols = header.map((h) => h.toLowerCase());
    if (!(cols.includes('id') && cols.includes('minimum rigor') && cols.includes('path patterns'))) continue;
    const triggers = [];
    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitRow(lines[j]);
      if (!cells) break;
      const get = (name) => cells[cols.indexOf(name)] ?? '';
      const minRigor = get('minimum rigor').toLowerCase();
      if (!RIGORS.includes(minRigor)) throw new UsageError(`trigger "${get('id')}" has minimum rigor "${get('minimum rigor')}", not one of ${RIGORS.join(', ')}`, 65);
      const globs = [...get('path patterns').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      triggers.push({ id: get('id'), minRigor, globs, patterns: globs.map(globToRegExp) });
    }
    return triggers;
  }
  return null;
}

export function loadImplementation(file = DEFAULT_IMPLEMENTATION) {
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new UsageError(`cannot read the IMPLEMENTATION at ${file}: ${e.message}`, 65);
  }
  const triggers = parseTriggers(md);
  if (!triggers || triggers.length === 0) throw new UsageError(`${file} has no trigger table (header: id | Trigger | Minimum rigor | Path patterns)`, 65);
  const window = /Distribution window:\s*(\d+)/i.exec(md);
  const enforced = /Enforced from:\s*(\d{4}-\d{2}-\d{2})/i.exec(md);
  return { file, triggers, window: window ? Number(window[1]) : 30, enforcedFrom: enforced ? enforced[1] : null };
}

// ---------------------------------------------------------------------------------------------
// Derivation (STRATEGY 6.6, 6.7)
// ---------------------------------------------------------------------------------------------

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|sh)$/;
const TEST_FILE = /(?:\.|-)(?:spec|test|e2e)(?:\.[a-z]+)*\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|test|tests)\//;
/** Source or test paths: what a `no-code` change may not touch. */
export const isCodeOrTest = (p) => CODE_EXT.test(p) || TEST_FILE.test(p);
/** A behavior-bearing file: code that is not a test. */
export const isBehaviorBearing = (p) => CODE_EXT.test(p) && !TEST_FILE.test(p);
/** Paths of a shipped package: touching one alters an artifact (G10). */
export const shipsArtifact = (p) => /^(?:entrypoint|packages)\/[^/]+\/(?:src\/|package\.json$|project\.json$)/.test(p) && !TEST_FILE.test(p);
/** Test infrastructure and gates (G11). */
export const isTestInfrastructure = (p) => /^(?:tools\/nx-plugins\/test\/|tools\/gate\/|\.githooks\/|docs\/standards\/testing\.md$|docs\/testing\/)/.test(p);

export function classInfo(cls) {
  if (!Object.prototype.hasOwnProperty.call(CLASSES, cls ?? '')) {
    throw new UsageError(`unknown change class "${cls ?? ''}"; one of ${Object.keys(CLASSES).join(', ')}`, 65);
  }
  return CLASSES[cls];
}

/** Rigor = the higher of the class default and every trigger hit; a trigger can only raise it. */
export function deriveRigor({ cls, paths = [], asserted = [], triggers, runtimeDependency = false }) {
  const info = classInfo(cls);
  let classDefault = info.rigor;
  if (cls === 'dependency' && runtimeDependency) classDefault = 'standard';
  const byId = new Map(triggers.map((t) => [t.id, t]));
  const hits = new Map();
  for (const t of triggers) {
    const matched = paths.filter((p) => t.patterns.some((re) => re.test(p)));
    if (matched.length) hits.set(t.id, { id: t.id, source: 'path', minRigor: t.minRigor, paths: matched });
  }
  for (const id of asserted) {
    if (id === 'none') continue;
    const t = byId.get(id);
    if (!t) throw new UsageError(`unknown trigger "${id}"; one of ${triggers.map((x) => x.id).join(', ')}`, 65);
    if (!hits.has(id)) hits.set(id, { id, source: 'asserted', minRigor: t.minRigor, paths: [] });
  }
  let rigor = classDefault;
  for (const h of hits.values()) rigor = maxRigor(rigor, h.minRigor);
  return { rigor, classDefault, triggers: [...hits.values()] };
}

/** STRATEGY 6.6 and 6.7, and the IMPLEMENTATION's authorship table. */
export function authorshipFor(cls, rigor) {
  if (rigor === 'none') return 'none';
  if (cls === 'test-maintenance') return 'editor-never-confirmer';
  if (cls === 'refactor' && rigor === 'light') return 'no-new-tests';
  if (rigor === 'light') return 'implementer-may-author';
  if (rigor === 'standard') return 'separated';
  return 'separated-required';
}

const gateOrder = (a, b) => Number(a.slice(1)) - Number(b.slice(1));

export function gatesFor({ cls, rigor, paths = [], artifact = false }) {
  const gates = new Set(NEVER_RELAXED);
  if (artifact || paths.some(shipsArtifact)) gates.add('G10');
  const authorsTests = ['new-behavior', 'defect-fix', 'boundary-contract', 'test-maintenance'].includes(cls);
  if (cls !== 'no-code') ['G3', 'G5', 'G7'].forEach((g) => gates.add(g));
  if (authorsTests) { gates.add('G6'); gates.add('G9'); }
  if (cls !== 'no-code' && rank(rigor) >= rank('standard')) gates.add('G8');
  if (paths.some(isTestInfrastructure)) gates.add('G11');
  return [...gates].sort(gateOrder);
}

/** What the class and scope contradict: `no-code` touching code or tests; `refactor` adding behavior-bearing code. */
export function inconsistencies({ cls, paths = [], added = [] }) {
  const out = [];
  if (cls === 'no-code') {
    const bad = paths.filter(isCodeOrTest);
    if (bad.length) out.push(`class no-code touches source or test paths: ${bad.join(', ')}`);
  }
  if (cls === 'refactor') {
    const bad = added.filter(isBehaviorBearing);
    if (bad.length) out.push(`class refactor adds behavior-bearing files: ${bad.join(', ')}`);
  }
  return out;
}

export function dispatchFor(cls, rigor) {
  const skipped = [];
  if (rigor === 'none') skipped.push('static-review', 'qa');
  else if (rigor === 'light') skipped.push('qa');
  return {
    staticReview: rigor !== 'none',
    qa: rank(rigor) >= rank('standard'),
    skipped,
    note: skipped.length
      ? `skipping the ${skipped.join(' and ')} dispatch${skipped.length > 1 ? 'es' : ''} at rigor ${rigor} is a dispatch choice; every gate in "gates" still applies`
      : 'no dispatch skipped',
  };
}

export function route({ cls, paths = [], added = [], asserted = [], artifact = false, runtimeDependency = false, coordinator = false, testAuthor = false, implementation }) {
  const derived = deriveRigor({ cls, paths, asserted, triggers: implementation.triggers, runtimeDependency });
  const problems = inconsistencies({ cls, paths, added });
  const out = {
    ok: problems.length === 0,
    class: cls,
    rigor: derived.rigor,
    classDefault: derived.classDefault,
    triggers: derived.triggers,
    authorship: authorshipFor(cls, derived.rigor),
    playbook: classInfo(cls).playbook,
    gates: gatesFor({ cls, rigor: derived.rigor, paths, artifact }),
    dispatch: dispatchFor(cls, derived.rigor),
  };
  if (problems.length) { out.inconsistent = problems; out.exit = 1; return out; }
  if (derived.rigor === 'deep' && (!coordinator || !testAuthor)) {
    const missing = [!coordinator && 'coordinator', !testAuthor && 'available test author'].filter(Boolean).join(' and ');
    out.ok = false;
    out.refused = true;
    out.reason = `Deep requires separated authorship and independent approval (STRATEGY 6.6, 13.2): no ${missing} is declared, so the change is refused or escalated to the owner`;
    out.exit = 3;
    return out;
  }
  out.exit = 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// The record (formats/testing-record.md) and the check (G12)
// ---------------------------------------------------------------------------------------------

/** Fields of a `## Testing record` section, or null. The same grammar as the harness's testing-record.mjs. */
export function parseRecord(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Testing record\s*$/.test(l));
  if (start === -1) return null;
  const fields = {};
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(lines[i].trim());
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  return fields;
}

const parseList = (v) => (v ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

/** G12 for one change: its recorded rigor against the derived rigor, and its planning record. */
export function checkRecord({ body, paths = [], added = [], implementation }) {
  const errors = [];
  const rec = parseRecord(body);
  if (rec === null) return { ok: false, errors: ['the rigor record is absent: the change has no "## Testing record" section (G12)'], derived: null };
  const cls = rec['change-class'];
  if (!Object.prototype.hasOwnProperty.call(CLASSES, cls ?? '')) {
    return { ok: false, errors: [`change-class "${cls ?? ''}" is not one of ${Object.keys(CLASSES).join(', ')}`], derived: null };
  }
  if (!RIGORS.includes(rec.rigor)) errors.push(`rigor "${rec.rigor ?? ''}" is not one of ${RIGORS.join(', ')}`);
  const asserted = parseList(rec.triggers);
  const derived = deriveRigor({ cls, paths, asserted, triggers: implementation.triggers });
  if (RIGORS.includes(rec.rigor) && rank(rec.rigor) < rank(derived.rigor)) {
    errors.push(`recorded rigor ${rec.rigor} is below the derived rigor ${derived.rigor} (class ${cls} gives ${derived.classDefault}; triggers: ${derived.triggers.map((t) => t.id).join(', ') || 'none'})`);
  }
  const effective = RIGORS.includes(rec.rigor) ? maxRigor(rec.rigor, derived.rigor) : derived.rigor;
  if (rank(effective) >= rank('standard') && !rec['not-testing']) {
    errors.push(`a ${effective} change has no "not-testing:" list; "none" is a valid answer, absence is not (G12)`);
  }
  errors.push(...inconsistencies({ cls, paths, added }));
  return { ok: errors.length === 0, errors, derived: { rigor: derived.rigor, classDefault: derived.classDefault, triggers: derived.triggers.map((t) => t.id) }, record: { class: cls, rigor: rec.rigor } };
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new UsageError(`git ${args.join(' ')} failed: ${(e.stderr || e.message).toString().trim()}`, 65);
  }
}

const SEP = '\u001f';
const END = '\u001e';

function parseLog(raw) {
  return raw.split(END).map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((r) => {
    const [sha, date, ...rest] = r.split(SEP);
    return { sha, date, body: rest.join(SEP) };
  });
}

const changedPaths = (sha, cwd) => git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha], cwd).split('\n').filter(Boolean);

/**
 * G12 over a commit range. The change is the branch's own work: commits are `base..head` (a three-dot
 * range is normalised, so commits only the base gained are not the branch's) and the changed paths are
 * the diff from the merge-base to head. Its record is the newest commit message in scope that carries a
 * `## Testing record`. Commits authored before the enforcement date are exempt.
 */
export function checkRange({ range, implementation, cwd = REPO_ROOT }) {
  const [base, head = 'HEAD'] = range.includes('...') ? range.split('...') : range.split('..');
  const commits = parseLog(git(['log', `--format=%H${SEP}%aI${SEP}%B${END}`, `${base}..${head}`], cwd));
  const from = implementation.enforcedFrom;
  const inScope = commits.filter((c) => !from || c.date.slice(0, 10) >= from);
  if (inScope.length === 0) {
    return { ok: true, exempt: true, errors: [], note: commits.length ? `every commit in ${range} predates the enforcement date ${from}` : `${range} holds no commits` };
  }
  const paths = git(['diff', '--name-only', `${base}...${head}`], cwd).split('\n').filter(Boolean);
  const added = git(['diff', '--name-only', '--diff-filter=A', `${base}...${head}`], cwd).split('\n').filter(Boolean);
  const withRecord = inScope.find((c) => parseRecord(c.body) !== null);
  const result = checkRecord({ body: withRecord ? withRecord.body : '', paths, added, implementation });
  return { ...result, range, commits: inScope.length, recordCommit: withRecord ? withRecord.sha : null };
}

/** The derived-rigor distribution over the last N merged changes (D24). */
export function distribution({ last, ref = 'HEAD', implementation, cwd = REPO_ROOT }) {
  const commits = parseLog(git(['log', '--first-parent', '-n', String(last), `--format=%H${SEP}%aI${SEP}%B${END}`, ref], cwd));
  const counts = { none: 0, light: 0, standard: 0, deep: 0 };
  let unrecorded = 0;
  for (const c of commits) {
    const rec = parseRecord(c.body);
    const valid = rec && Object.prototype.hasOwnProperty.call(CLASSES, rec['change-class'] ?? '');
    if (!valid) unrecorded += 1;
    const cls = valid ? rec['change-class'] : 'new-behavior';
    const asserted = valid ? parseList(rec.triggers).filter((t) => implementation.triggers.some((x) => x.id === t)) : [];
    const { rigor } = deriveRigor({ cls, paths: changedPaths(c.sha, cwd), asserted, triggers: implementation.triggers });
    counts[rigor] += 1;
  }
  const n = commits.length;
  const share = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, n ? Math.round((v / n) * 1000) / 10 : 0]));
  return { ok: true, n, requested: last, ref, distribution: counts, percent: share, unrecorded };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const FLAGS_WITH_VALUE = new Set(['--class', '--scope', '--added', '--trigger', '--coordinator', '--test-author', '--implementation', '--record-file', '--range', '--last', '--ref', '--changed-from']);
const BOOLEAN_FLAGS = new Set(['--artifact', '--runtime-dependency']);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const opts = { verb, scope: [], added: [], trigger: [] };
  for (let i = 0; i < rest.length; i++) {
    let a = rest[i];
    let inline;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (BOOLEAN_FLAGS.has(a)) { opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(a)) throw new UsageError(`unknown argument ${a}`);
    const value = inline ?? rest[++i];
    if (value === undefined) throw new UsageError(`${a} needs a value`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'scope' || key === 'added' || key === 'trigger') opts[key].push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    else opts[key] = value;
  }
  return opts;
}

const yes = (v) => v === 'yes' || v === 'true';

/** git runs in `cwd` (default: the caller's directory, so a hook pushing from any worktree reads its own history). */
export function run(argv, { cwd = process.cwd() } = {}) {
  const opts = parseArgs(argv);
  if (!['route', 'check', 'distribution'].includes(opts.verb ?? '')) {
    throw new UsageError('usage: test-routing.mjs route --class <c> [--scope p]... [--added p]... [--trigger id]... [--artifact] [--coordinator yes] [--test-author yes]\n       test-routing.mjs check (--record-file <f> [--scope p]... | --range <a..b>) [--changed-from <ref>]\n       test-routing.mjs distribution [--last N] [--ref <ref>]   (all: [--implementation <md>])');
  }
  const implementation = loadImplementation(opts.implementation ? path.resolve(cwd, opts.implementation) : DEFAULT_IMPLEMENTATION);
  if (opts.verb === 'route') {
    if (!opts.class) throw new UsageError('route needs --class');
    const result = route({
      cls: opts.class, paths: opts.scope, added: opts.added, asserted: opts.trigger,
      artifact: Boolean(opts.artifact), runtimeDependency: Boolean(opts.runtimeDependency),
      coordinator: yes(opts.coordinator), testAuthor: yes(opts.testAuthor), implementation,
    });
    return { result, exit: result.exit };
  }
  if (opts.verb === 'check') {
    if (opts.range) {
      const result = checkRange({ range: opts.range, implementation, cwd });
      return { result, exit: result.ok ? 0 : 1 };
    }
    if (!opts.recordFile) throw new UsageError('check needs --record-file or --range');
    let body;
    try { body = fs.readFileSync(path.resolve(cwd, opts.recordFile), 'utf8'); } catch (e) { throw new UsageError(`cannot read ${opts.recordFile}: ${e.message}`, 65); }
    let paths = opts.scope;
    if (opts.changedFrom) paths = [...paths, ...git(['diff', '--name-only', opts.changedFrom], cwd).split('\n').filter(Boolean)];
    const result = checkRecord({ body, paths, added: opts.added, implementation });
    return { result, exit: result.ok ? 0 : 1 };
  }
  const last = opts.last === undefined ? implementation.window : Number(opts.last);
  if (!Number.isInteger(last) || last < 1) throw new UsageError('--last needs a positive integer');
  return { result: distribution({ last, ref: opts.ref ?? 'HEAD', implementation, cwd }), exit: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { result, exit } = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exit);
  } catch (e) {
    const exit = e instanceof UsageError ? e.exit : 1;
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: exit === 64 ? 'E_USAGE' : 'E_INPUT', exit, message: e.message } })}\n`);
    process.exit(exit);
  }
}
