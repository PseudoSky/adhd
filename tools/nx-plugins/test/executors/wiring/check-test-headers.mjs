#!/usr/bin/env node
/**
 * check-test-headers — gate G9 (every tier P, H or X test carries a valid fidelity-gap statement) and the header half
 * of G12 (every new test has a header). Backlog 595965cc T34; the finding that made it necessary is b87dcea0: specs that
 * spawn processes were headed tier S and the header was reworded instead of the tier corrected. Nothing but a
 * reviewer caught it, so this check reads the code, not the claim.
 *
 * HEADER. The first comment block in the first 60 lines of a test file (`*.spec.*`, `*.test.*`, `*.e2e.*`) carries
 *   guards: <one failure mode>    tier: S|P|H|X    cites: <item and criterion>
 * and, for tier P, H or X, `gap: This cannot be observed at tier <T-1> because <concrete property>.`
 * (format: standards/testing/formats/test-header.md of the workspace-standards skill).
 *
 * RULES (any violation => exit 1)
 *   H1 header-incomplete  no header with guards, tier and cites.
 *   H2 tier-invalid       the tier is not S, P, H or X.
 *   H3 gap-missing        tier P, H or X with no `cannot be observed at tier <T> because <property>` statement.
 *   H4 spawn-in-tier-S    the header says tier S and the code spawns a process (child_process, a stdio MCP client).
 *   B  baseline           a violation the baseline does not record fails; a baselined violation that no longer
 *                         occurs also fails until `--write-baseline` lowers it, so the baseline only shrinks.
 *
 * usage: check-test-headers.mjs [--workspace-root <dir>] [--baseline <file>] [--report <file>] [--write-baseline]
 * exit:  0 clean, 1 violation, 65 unreadable baseline or bad argument
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank, listTestFiles } from './check-skip-expiry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
export const BASELINE_PATH = join(HERE, 'test-headers.baseline.json');

/** The header block text: the first comment block within the first 60 lines, comment markers stripped. */
export function headerOf(src) {
  const lines = src.split('\n').slice(0, 60);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#!') || /^['"]use strict['"];?$/.test(lines[i].trim()))) i++;
  const first = (lines[i] ?? '').trim();
  const out = [];
  if (first.startsWith('/*')) {
    for (let j = i; j < lines.length; j++) {
      out.push(lines[j].replace(/^\s*\/\*+\s?|\s*\*+\/\s*$|^\s*\*\s?/g, ''));
      if (lines[j].includes('*/')) break;
    }
  } else if (first.startsWith('//')) {
    for (let j = i; j < lines.length && lines[j].trim().startsWith('//'); j++) out.push(lines[j].replace(/^\s*\/\/\s?/, ''));
  }
  return out.join('\n');
}

const field = (header, name) => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mi').exec(header)?.[1]?.trim() ?? null;

const CP_IMPORT = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|\bStdioClientTransport\b|\bStdioMcpClient\b/;
const CP_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(|\bStdioClientTransport\b|\bStdioMcpClient\b/;

/** True when the code starts a process; comments, strings and regex literals are blanked first. */
export const spawnsProcess = (src) => CP_IMPORT.test(src) && CP_CALL.test(blank(src));

/** The rule ids a test file violates. */
export function judge(src) {
  const header = headerOf(src);
  const guards = field(header, 'guards');
  const tier = field(header, 'tier');
  const cites = field(header, 'cites');
  const rules = [];
  if (!guards || !tier || !cites) rules.push('H1');
  const letter = tier ? /^([A-Za-z])\b/.exec(tier)?.[1] : null;
  if (tier && !['S', 'P', 'H', 'X'].includes(letter ?? '')) rules.push('H2');
  if (['P', 'H', 'X'].includes(letter ?? '') && !/cannot be observed at tier [SPHX] because\s+\S/i.test(field(header, 'gap') ?? '')) rules.push('H3');
  if (letter === 'S' && spawnsProcess(src)) rules.push('H4');
  return rules;
}

export function collect(workspaceRoot) {
  const found = {};
  const paths = listTestFiles(workspaceRoot);
  for (const rel of paths) {
    let src;
    try {
      src = readFileSync(join(workspaceRoot, rel), 'utf8');
    } catch (err) {
      console.error(`check-test-headers: cannot read ${rel}: ${err.message}`);
      found[rel] = ['unreadable'];
      continue;
    }
    const rules = judge(src);
    if (rules.length) found[rel] = rules;
  }
  return { files: paths.length, found };
}

export function evaluate(found, baseline) {
  const violations = [];
  for (const [rel, rules] of Object.entries(found)) {
    const allowed = new Set(baseline.files?.[rel] ?? []);
    const fresh = rules.filter((r) => !allowed.has(r));
    if (fresh.length) violations.push({ rule: 'B', detail: `${rel} violates ${fresh.join(', ')} (see the rules in check-test-headers.mjs); fix the header or the tier, never reword one to excuse the other` });
  }
  for (const [rel, rules] of Object.entries(baseline.files ?? {})) {
    const now = new Set(found[rel] ?? []);
    const gone = rules.filter((r) => !now.has(r));
    if (gone.length) violations.push({ rule: 'B', detail: `${rel} no longer violates ${gone.join(', ')}; lower the baseline with --write-baseline` });
  }
  return violations;
}

function loadBaseline(file) {
  if (!existsSync(file)) return { files: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function main(argv) {
  const opt = { root: REPO_ROOT, baseline: BASELINE_PATH, report: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace-root') opt.root = resolve(argv[++i]);
    else if (a === '--baseline') opt.baseline = resolve(argv[++i]);
    else if (a === '--report') opt.report = resolve(argv[++i]);
    else if (a === '--write-baseline') opt.write = true;
    else { console.error(`unknown argument ${a}\nusage: check-test-headers.mjs [--workspace-root <dir>] [--baseline <file>] [--report <file>] [--write-baseline]`); return 65; }
  }
  const { files, found } = collect(opt.root);
  if (opt.write) {
    const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(opt.baseline, `${JSON.stringify({ $comment: 'Legacy test-header violations per file (check-test-headers.mjs). It only shrinks: a new violation fails, a fixed one must be removed here.', files: sorted }, null, 2)}\n`);
    console.log(`wrote ${opt.baseline}: ${Object.keys(sorted).length} file(s) with a recorded violation`);
    return 0;
  }
  let baseline;
  try {
    baseline = loadBaseline(opt.baseline);
  } catch (err) {
    console.error(`check-test-headers: baseline ${opt.baseline} is unreadable: ${err.message}`);
    return 65;
  }
  const violations = evaluate(found, baseline);
  const perRule = {};
  for (const rules of Object.values(found)) for (const r of rules) perRule[r] = (perRule[r] ?? 0) + 1;
  const report = { kind: 'test-header-report', scannedFiles: files, filesWithViolations: Object.keys(found).length, perRule, baselined: Object.keys(baseline.files ?? {}).length, violations };
  if (opt.report) writeFileSync(opt.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const v of violations) console.error(`${v.rule}: ${v.detail}`);
  console.log(JSON.stringify({ ...report, violations: violations.length }));
  return violations.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
