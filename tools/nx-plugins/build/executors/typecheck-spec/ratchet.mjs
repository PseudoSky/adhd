#!/usr/bin/env node
/**
 * ratchet.mjs — a type-check gate for a project's SPEC tsconfig that CAN fail.
 *
 * THE CLASS THIS CLOSES (backlog 98142eab / 55e54233). `entrypoint/backlog`
 * ships `tsconfig.spec.json`, but NOTHING compiled it: `nx.json`'s `production`
 * namedInput excludes it and no target referenced it. So the spec corpus had
 * 196 live type errors that no gate could ever surface — a check that cannot
 * fail is not a check. Deleting/repairing all 196 (all under the forbidden
 * `entrypoint/backlog/src/**`) is out of this change's scope, so the honest
 * fix is a RATCHET: prove the spec tsconfig actually compiles every spec file,
 * then fail on any error ABOVE the recorded baseline. The baseline is
 * generated from the real tree and COMMITTED; it may only go DOWN.
 *
 * TWO PARTS, both load-bearing:
 *
 *  1. COVERAGE FLOOR (anti-narrowing). tsc is run with `--listFiles`; every
 *     file matched by the tsconfig's own `include` patterns must appear in the
 *     checked set. Otherwise a future edit could silence this gate by simply
 *     narrowing `include` (or a `files`/`exclude` change) — a green run over
 *     zero files. A spec file that is not type-checked FAILS, loudly.
 *
 *  2. ERROR RATCHET (per-file). tsc's diagnostics are grouped per file and
 *     compared to the baseline. ANY file whose error count rose — or any file
 *     absent from the baseline that now has errors — FAILS, even if another
 *     file improved and the total stayed flat. Improvements are allowed and
 *     reported; they never fail the gate.
 *
 * Exit 0  — every included spec file was type-checked and no count rose.
 * Exit 1  — a regression (new errors, or a spec file no longer checked).
 * Exit 2  — setup/usage error (tsconfig/include unreadable, tsc could not run,
 *           or no baseline while not writing one).
 *
 * Usage:
 *   node ratchet.mjs --tsconfig <path> --baseline <path>   # gate
 *   node ratchet.mjs --tsconfig <path> --write-baseline    # (re)generate
 * --project-root defaults to the tsconfig's directory (must contain the
 * tsconfig's include-relative files).
 */

import { existsSync, globSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

function fail(code, message) {
  console.error(`✖ typecheck-spec ratchet: ${message}`);
  process.exit(code);
}

function findWorkspaceRoot(start) {
  let d = start;
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return start;
}

function parseArgs(argv) {
  const out = { writeBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tsconfig') out.tsconfig = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--project-root') out.projectRoot = argv[++i];
    else if (a === '--write-baseline') out.writeBaseline = true;
    else fail(2, `unknown argument "${a}"`);
  }
  return out;
}

/**
 * Strip `//` and `/* *\/` comments ONLY outside string literals. A naive
 * regex strip corrupts glob patterns — `src/**\/*.spec.ts` contains a literal
 * `/**\/` that a block-comment regex happily deletes (turning the include glob
 * into `src*.spec.ts`, which matches nothing and would silently zero the
 * coverage floor). String-aware scanning is required.
 */
function stripJsonComments(s) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Read a JSON file with `//`/`/* *\/`-comment + trailing-comma tolerance (tsconfigs). */
function readJsonc(path) {
  const raw = stripJsonComments(readFileSync(path, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

/**
 * Resolve the leaf tsconfig's `include` patterns, following `extends` only if
 * the leaf declares none (include is overridden, not merged, by a child that
 * declares it — matching tsc).
 */
function resolveInclude(tsconfigPath, seen = new Set()) {
  const abs = resolvePath(tsconfigPath);
  if (seen.has(abs)) fail(2, `circular tsconfig extends at ${abs}`);
  seen.add(abs);
  const cfg = readJsonc(abs);
  if (Array.isArray(cfg.include) && cfg.include.length > 0) {
    return { base: dirname(abs), include: cfg.include };
  }
  if (typeof cfg.extends === 'string') {
    const parent = cfg.extends.startsWith('.')
      ? resolvePath(dirname(abs), cfg.extends)
      : join(findWorkspaceRoot(dirname(abs)), 'node_modules', cfg.extends);
    return resolveInclude(parent.endsWith('.json') ? parent : `${parent}.json`, seen);
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tsconfig) fail(2, 'missing --tsconfig');

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const tsconfigAbs = resolvePath(process.cwd(), args.tsconfig);
  if (!existsSync(tsconfigAbs)) fail(2, `tsconfig not found: ${tsconfigAbs}`);
  const projectRoot = resolvePath(args.projectRoot ?? dirname(tsconfigAbs));

  const resolved = resolveInclude(tsconfigAbs);
  if (!resolved) fail(2, `could not resolve an 'include' from ${tsconfigAbs}`);
  if (resolvePath(resolved.base) !== projectRoot) {
    fail(2, `tsconfig 'include' base ${resolved.base} != --project-root ${projectRoot}`);
  }

  // The corpus that MUST be type-checked: every file the tsconfig's own
  // include patterns match. This is the anti-narrowing floor's ground truth.
  const corpusAbs = new Set();
  for (const pattern of resolved.include) {
    const matches = globSync(pattern, { cwd: projectRoot, exclude: (name) => name === 'node_modules' || name === 'dist' });
    for (const m of matches) corpusAbs.add(resolvePath(projectRoot, m));
  }
  if (corpusAbs.size === 0) fail(2, `tsconfig 'include' matched no files under ${projectRoot} — refusing to ratchet an empty corpus`);

  const tscBin = join(workspaceRoot, 'node_modules', '.bin', 'tsc');
  const tscCmd = existsSync(tscBin) ? tscBin : 'tsc';
  const res = spawnSync(tscCmd, ['-p', tsconfigAbs, '--noEmit', '--pretty', 'false', '--listFiles'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) fail(2, `could not run tsc (${tscCmd}): ${res.error.message}`);
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

  // --listFiles prints absolute paths (one per line); diagnostics print
  // cwd-relative `file(line,col): error TSxxxx:` on one line each.
  const checked = new Set();
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/') && /\.(d\.ts|ts|tsx|mts|cts|mjs|js)$/.test(t)) checked.add(t);
  }
  const errorsByFile = new Map();
  const ERR_RE = /^(.+?)\((\d+),(\d+)\): error TS(\d+):/gm;
  for (const m of output.matchAll(ERR_RE)) {
    const fileRaw = m[1].trim();
    const abs = realpathSafe(isAbsolute(fileRaw) ? fileRaw : resolvePath(workspaceRoot, fileRaw));
    errorsByFile.set(abs, (errorsByFile.get(abs) ?? 0) + 1);
  }

  // 1) COVERAGE FLOOR — the tsconfig must actually check every included file.
  const missing = [];
  for (const f of corpusAbs) if (!checked.has(realpathSafe(f))) missing.push(f);
  if (missing.length > 0) {
    console.error('✖ typecheck-spec ratchet: the spec tsconfig does NOT type-check every file it includes.');
    for (const f of missing.slice(0, 20)) console.error(`   not checked: ${rel(workspaceRoot, f)}`);
    if (missing.length > 20) console.error(`   …and ${missing.length - 20} more`);
    console.error('   (This gate exists to compile the WHOLE spec corpus; narrowing include/exclude to make it pass is exactly what it guards against.)');
    process.exit(1);
  }

  // 2) ERROR RATCHET — per-file, so a fix in one file cannot hide a new error in another.
  const current = { total: 0, files: {} };
  for (const f of [...errorsByFile.keys()].sort()) {
    const n = errorsByFile.get(f);
    current.total += n;
    current.files[rel(workspaceRoot, f)] = n;
  }

  if (args.writeBaseline) {
    if (!args.baseline) fail(2, '--write-baseline requires --baseline <path>');
    const abs = resolvePath(process.cwd(), args.baseline);
    mkdirSync(dirname(abs), { recursive: true });
    const payload = {
      '//':
        'typecheck-spec ratchet baseline for entrypoint/backlog/tsconfig.spec.json — generated by ' +
        'tools/nx-plugins/build/executors/typecheck-spec/ratchet.mjs --write-baseline. Per-file error counts; ' +
        'the gate fails on any INCREASE (or a new file with errors). This number may only go DOWN — fix errors ' +
        'and regenerate. See backlog 55e54233 (the 196 pre-existing spec type errors this baselines) and ' +
        '98142eab (the gate-that-cannot-fail class).',
      total: current.total,
      files: current.files,
    };
    writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`✓ typecheck-spec ratchet: baseline written (${current.total} error(s)) -> ${rel(workspaceRoot, abs)}`);
    process.exit(0);
  }

  if (!args.baseline) fail(2, 'missing --baseline (or pass --write-baseline)');
  const baselineAbs = resolvePath(process.cwd(), args.baseline);
  if (!existsSync(baselineAbs)) fail(2, `baseline not found: ${baselineAbs} (run with --write-baseline to create it)`);
  const baseline = JSON.parse(readFileSync(baselineAbs, 'utf8'));
  const baseFiles = baseline.files ?? {};

  const regressions = [];
  for (const [file, count] of Object.entries(current.files)) {
    const base = baseFiles[file] ?? 0;
    if (count > base) regressions.push({ file, base, count });
  }
  regressions.sort((a, b) => b.count - b.base - (a.count - a.base));

  if (regressions.length > 0) {
    console.error('✖ typecheck-spec ratchet: spec type errors INCREASED above the baseline:');
    for (const r of regressions) console.error(`   ${r.file}: ${r.base} -> ${r.count}  (+${r.count - r.base})`);
    console.error(`\n   baseline total ${baseline.total ?? '?'}, current total ${current.total}.`);
    console.error('   Fix the new type error(s), or (only if they are a deliberate, reviewed change) regenerate the baseline.');
    process.exit(1);
  }

  const improved = (baseline.total ?? 0) - current.total;
  console.log(`✓ typecheck-spec ratchet: ${current.total} spec type error(s) — no regression vs baseline ${baseline.total ?? '?'} (corpus: ${corpusAbs.size} file(s) all type-checked).`);
  if (improved > 0) {
    console.log(`  ↓ ${improved} fewer than baseline — nice. Lower it: re-run with --write-baseline.`);
  }
  process.exit(0);
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function rel(root, p) {
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

main();
