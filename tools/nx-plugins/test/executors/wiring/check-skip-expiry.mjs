#!/usr/bin/env node
/**
 * check-skip-expiry — gate G4 (STRATEGY: every skip, todo, disabled marker and review-debt entry has a
 * tracking item and an unexpired date). Backlog 595965cc T32.
 *
 * WHAT COUNTS AS A MARKER. In a test file (`*.spec.*`, `*.test.*`, `*.e2e.*`), found in code only (comments,
 * strings and template literals are blanked first, so a fixture or a docstring that mentions a marker is not one):
 *   skip: `it|test|describe .skip(`, `.skipIf(`, `xit|xtest|xdescribe(`, `t.skip(` / `ctx.skip(`, and a
 *         `skip:` option on an `it|test|describe` call whose value is not `false`
 *   todo: `it|test|describe .todo(` and a `todo:` option on such a call whose value is not `false`
 *
 * ANNOTATION. A marker is tracked when its own statement, or the comment lines directly above it, name a
 * tracking item and an expiry:   `<8 hex> ... until YYYY-MM-DD`   (for example `backlog ca23e252 until 2026-12-31`).
 * A file-level pragma covers every marker in the file:   `// skip-expiry: <8 hex> until YYYY-MM-DD <reason>`.
 * The id is format-checked only: this check is offline, so it cannot prove the item exists.
 *
 * RULES (any violation => exit 1)
 *   A. (unannotated) a marker with no tracking item and date fails, beyond what the baseline records for its file.
 *   B. (expired)     a marker whose date has passed, or whose date is not a real calendar date, fails.
 *   C. (baseline-stale)   the baseline records legacy unannotated markers per file; it may only shrink. A file
 *                    holding fewer than its baseline says fails until `--write-baseline` lowers it.
 *   D. (baseline-expired) the baseline carries a `reviewBy` date; past it, any remaining legacy marker fails.
 *
 * T32.AC3: every run reports the counts it measured (skip and todo markers, stub spec files whose tests are all
 * todo) with the commit it ran on; `--write-baseline` records them. The counts in the plan are the ones observed
 * when the items were filed; this report is the current measurement.
 *
 * usage: check-skip-expiry.mjs [--workspace-root <dir>] [--baseline <file>] [--today YYYY-MM-DD]
 *                              [--report <file>] [--write-baseline [--review-by YYYY-MM-DD]]
 * exit:  0 clean, 1 violation, 65 unreadable baseline or bad argument
 */
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync as realpathForEntry } from 'node:fs';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../../lib/git-env.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
export const BASELINE_PATH = join(HERE, 'skip-expiry.baseline.json');
const SKIP_DIRS = /(^|\/)(node_modules|dist|\.worktrees|\.claude|\.nx|\.git)(\/|$)/;
const TEST_GLOB = '**/*.{spec,test,e2e}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A `/` starts a regex literal (not a division) after one of these tokens or at the start of the text. */
function regexAllowed(out) {
  // Look at the tail only. `out.replace(/\s+$/, '')` rescanned the whole output on every `/`, and a blanked comment
  // or string leaves long runs of spaces, so the scan went quadratic: 10.6 s of a 10.9 s run on 890 files (c40c33e1).
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1])) end -= 1;
  if (end === 0) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(out[end - 1])) return true;
  // Eight characters cover the longest keyword (six) plus the boundary character before it.
  return /\b(?:return|typeof|case|in|of|void|delete|throw|yield|await)$/.test(out.slice(Math.max(0, end - 8), end));
}

/** Index just past the regex literal (and its flags) starting at `i`, or `i` when no closing `/` is on the line. */
function regexEnd(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return i;
}

/** Blank comments, strings, regex literals and template literals to spaces, keeping every newline so line numbers hold. */
export function blank(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const keep = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += keep(src[i]); i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '/' && regexAllowed(out) && regexEnd(src, i) > i) {
      const end = regexEnd(src, i);
      while (i < end) { out += ' '; i++; }
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) { out += ' ' + keep(src[i + 1]); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break; // an unterminated ordinary string ends at the line
        out += keep(src[i]); i++;
      }
      if (i < n && src[i] === q) { out += ' '; i++; }
    } else { out += c; i++; }
  }
  return out;
}

/** Index of the paren closing the one at `open` in blanked code, or the end of the text. */
function closeParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return code.length;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const CALL_SKIP = /\b(?:(?:it|test|describe)\.(?:skip|skipIf)|x(?:it|test|describe)|(?:t|ctx|context)\.skip)\s*\(/g;
const CALL_TODO = /\b(?:it|test|describe)\.todo\s*\(/g;
const TEST_CALL = /\b(?:it|test|describe)\s*\(/g;
const OPTION = /\b(skip|todo)\s*:/g;
/** The option's value starts non-empty and is not `false`; read from the source, where strings are still text. */
const VALUED = /^\s*(?!false\b)[^\s,}]/;

/** The markers in one file: [{ kind, line }] in source order. */
export function findMarkers(src) {
  const code = blank(src);
  const found = new Map();
  const add = (kind, index) => { const line = lineOf(code, index); found.set(`${kind}:${line}`, { kind, line }); };
  for (const m of code.matchAll(CALL_SKIP)) add('skip', m.index);
  for (const m of code.matchAll(CALL_TODO)) add('todo', m.index);
  for (const m of code.matchAll(TEST_CALL)) {
    const open = m.index + m[0].length - 1;
    const args = code.slice(open + 1, closeParen(code, open));
    // The options object precedes the callback, so stop at the first function body.
    const head = args.split(/=>|\bfunction\b/)[0];
    for (const o of head.matchAll(OPTION)) {
      const at = open + 1 + o.index;
      if (VALUED.test(src.slice(at + o[0].length))) add(o[1], at);
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** A stub spec holds todo markers and no executable test call. */
export function isStubSpec(src, markers) {
  if (!markers.some((m) => m.kind === 'todo')) return false;
  const code = blank(src).replace(CALL_TODO, ' ').replace(CALL_SKIP, ' ');
  return !/\b(?:it|test)(?:\.(?:each|concurrent|sequential|fails))?\s*\(/.test(code);
}

const ANNOTATION = /\b([0-9a-f]{8})\b[^\n]*?\buntil\s+(\d{4}-\d{2}-\d{2})\b/i;
const PRAGMA = /skip-expiry:\s*([0-9a-f]{8})\b[^\n]*?\buntil\s+(\d{4}-\d{2}-\d{2})\b/i;

/** The tracking item and date a text names, or null when it names both in no order this check reads. */
export function parseAnnotation(text, pattern = ANNOTATION) {
  const m = pattern.exec(text);
  return m ? { id: m[1].toLowerCase(), date: m[2] } : null;
}

export const isRealDate = (s) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Annotation text for the marker: its statement plus the comment lines directly above it. */
function statementText(lines, code, marker) {
  const codeLines = code.split('\n');
  // An option marker (`skip:` / `todo:`) sits on a line inside the call's options object: the statement starts at
  // the nearest earlier line that opens an it/test/describe call.
  let first = marker.line;
  for (let l = marker.line; l >= Math.max(1, marker.line - 8); l--) {
    if (/\b(?:it|test|describe)(?:\.\w+)?\s*\(/.test(codeLines[l - 1])) { first = l; break; }
  }
  let end = first;
  let depth = 0;
  let seenOpen = false;
  for (let l = first; l <= Math.min(codeLines.length, Math.max(marker.line, first) + 8); l++) {
    for (const ch of codeLines[l - 1]) {
      if (ch === '(') { depth++; seenOpen = true; } else if (ch === ')') depth--;
    }
    end = l;
    if (seenOpen && depth <= 0 && l >= marker.line) break;
  }
  let start = first;
  while (start > 1 && /^\s*(\/\/|\/\*|\*)/.test(lines[start - 2])) start--;
  return lines.slice(start - 1, end).join('\n');
}

/** The markers of `src`, each with its annotation state against `today`. */
export function scanSource(src, today) {
  const lines = src.split('\n');
  const code = blank(src);
  const markers = findMarkers(src);
  const filePragma = parseAnnotation(src, PRAGMA);
  const out = markers.map((m) => {
    const ann = parseAnnotation(statementText(lines, code, m)) ?? filePragma;
    let state = 'unannotated';
    if (ann) state = !isRealDate(ann.date) || ann.date < today ? 'expired' : 'tracked';
    return { ...m, state, ...(ann ? { id: ann.id, date: ann.date } : {}) };
  });
  return { markers: out, stub: isStubSpec(src, markers) };
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    console.error(`check-skip-expiry: cannot read HEAD in ${cwd}: ${err.message}`);
    return null;
  }
}

const loadBaseline = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { reviewBy: null, files: {} });
const today0 = () => new Date().toISOString().slice(0, 10);

/**
 * The test files of `workspaceRoot`: the ones git tracks when it is a repository (an untracked scratch or rescue
 * directory in a developer checkout must not decide a push), else every match on disk (fixture workspaces).
 */
export function listTestFiles(workspaceRoot) {
  let tracked = null;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: workspaceRoot, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch (err) {
    // not a git repository (a fixture workspace): fall back to the files on disk below
    if (err?.status === undefined && err?.code !== 'ENOENT') console.error(`check-skip-expiry: git ls-files failed in ${workspaceRoot}: ${err.message}`);
  }
  const isTest = (p) => /\.(?:spec|test|e2e)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p);
  const paths = tracked
    ? tracked.filter((p) => isTest(p) && existsSync(join(workspaceRoot, p)))
    : globSync(TEST_GLOB, { cwd: workspaceRoot, exclude: (p) => SKIP_DIRS.test(String(p?.name ?? p).replaceAll('\\', '/')) });
  return paths.map((p) => p.replaceAll('\\', '/')).filter((p) => !SKIP_DIRS.test(p)).sort();
}

/**
 * Scan `workspaceRoot` and judge it against `baseline`. Returns { violations, legacy, report } where `legacy`
 * is the per-file unannotated count a `--write-baseline` run records.
 */
export function collectSkipExpiry(workspaceRoot, { baseline = loadBaseline(BASELINE_PATH), today = today0() } = {}) {
  const violations = [];
  const add = (rule, detail) => violations.push({ rule, detail });
  const counts = { skipMarkers: 0, todoMarkers: 0, stubSpecFiles: 0, tracked: 0, unannotated: 0, expired: 0 };
  const legacy = {};
  const paths = listTestFiles(workspaceRoot);
  for (const rel of paths) {
    let src;
    try {
      src = readFileSync(join(workspaceRoot, rel), 'utf8');
    } catch (err) {
      console.error(`check-skip-expiry: cannot read ${rel}: ${err.message}`);
      add('unreadable', `${rel} — ${err.message}`);
      continue;
    }
    const { markers, stub } = scanSource(src, today);
    if (markers.length === 0) continue;
    if (stub) counts.stubSpecFiles++;
    for (const m of markers) {
      counts[m.kind === 'skip' ? 'skipMarkers' : 'todoMarkers']++;
      if (m.state === 'tracked') counts.tracked++;
      if (m.state === 'expired') {
        counts.expired++;
        add('B-expired', `${rel}:${m.line} ${m.kind} names ${m.id} until ${m.date}, which is ${isRealDate(m.date) ? `before ${today}` : 'not a calendar date'}`);
      }
    }
    for (const kind of ['skip', 'todo']) {
      const bare = markers.filter((m) => m.kind === kind && m.state === 'unannotated');
      if (bare.length === 0) continue;
      counts.unannotated += bare.length;
      legacy[rel] = { ...(legacy[rel] ?? {}), [kind]: bare.length };
      const allowed = baseline.files?.[rel]?.[kind] ?? 0;
      if (bare.length > allowed) {
        add('A-unannotated', `${rel} has ${bare.length} ${kind} marker(s) with no tracking item and date, ${allowed} allowed by the baseline (lines ${bare.map((m) => m.line).join(', ')}); add "<8 hex id> until YYYY-MM-DD" to the statement or a skip-expiry pragma to the file`);
      }
    }
  }
  for (const [rel, kinds] of Object.entries(baseline.files ?? {})) {
    for (const [kind, allowed] of Object.entries(kinds)) {
      const actual = legacy[rel]?.[kind] ?? 0;
      if (actual < allowed) add('C-baseline-stale', `${rel} baseline allows ${allowed} untracked ${kind} marker(s) but holds ${actual}; run with --write-baseline so the ratchet only shrinks`);
    }
  }
  if (paths.length === 0) add('E-scan-found-nothing', `${workspaceRoot} — zero test files scanned; the walker is broken`);
  const remaining = Object.values(legacy).reduce((s, k) => s + Object.values(k).reduce((a, b) => a + b, 0), 0);
  if (baseline.reviewBy && today > baseline.reviewBy && remaining > 0) {
    add('D-baseline-expired', `the legacy baseline was due for review by ${baseline.reviewBy} and still holds ${remaining} untracked marker(s); track or remove them`);
  }
  return {
    violations,
    legacy,
    report: { kind: 'skip-expiry-report', commit: gitHead(workspaceRoot), today, scannedFiles: paths.length, counts, legacyUntracked: remaining, baselineReviewBy: baseline.reviewBy ?? null },
  };
}

function plusDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function main(argv) {
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(val('--workspace-root') ?? REPO_ROOT);
  const baselineFile = resolve(val('--baseline') ?? BASELINE_PATH);
  const today = val('--today') ?? today0();
  if (!isRealDate(today)) { console.error(`--today ${today} is not YYYY-MM-DD`); return 65; }
  let baseline;
  try {
    baseline = loadBaseline(baselineFile);
  } catch (err) {
    console.error(`check-skip-expiry: ${baselineFile} is not readable JSON: ${err.message}`);
    return 65;
  }
  const result = collectSkipExpiry(root, { baseline, today });
  if (argv.includes('--write-baseline')) {
    const reviewBy = val('--review-by') ?? baseline.reviewBy ?? plusDays(today, 90);
    if (!isRealDate(reviewBy)) { console.error(`--review-by ${reviewBy} is not YYYY-MM-DD`); return 65; }
    const next = { '//': 'Legacy skip/todo markers with no tracking item, per file. It may only shrink (rule C) and must be emptied by reviewBy (rule D). Regenerate with check-skip-expiry.mjs --write-baseline.', reviewBy, recordedAt: today, commit: result.report.commit, counts: result.report.counts, files: result.legacy };
    writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${relative(root, baselineFile) || baselineFile}: ${result.report.legacyUntracked} legacy marker(s) in ${Object.keys(result.legacy).length} file(s), reviewBy ${reviewBy}`);
    return 0;
  }
  const reportFile = val('--report');
  if (reportFile) writeFileSync(resolve(reportFile), `${JSON.stringify({ ...result.report, violations: result.violations }, null, 2)}\n`);
  console.log(JSON.stringify(result.report));
  if (result.violations.length > 0) {
    console.error('✖ skip/todo expiry check FAILED (G4):');
    for (const v of result.violations) console.error(`  [${v.rule}] ${v.detail}`);
    return 1;
  }
  return 0;
}

if ((() => { try { return realpathForEntry(process.argv[1]) === realpathForEntry(fileURLToPath(import.meta.url)); } catch { return process.argv[1] === fileURLToPath(import.meta.url); } })()) process.exit(main(process.argv.slice(2)));
