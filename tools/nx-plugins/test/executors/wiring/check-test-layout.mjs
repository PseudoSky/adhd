#!/usr/bin/env node
/**
 * check-test-layout — every TypeScript project under `packages/` and `entrypoint/` keeps its tests in
 * `<project>/test/`, laid out by lane (docs/standards/testing.md, "Test file layout").
 *
 * Layout contract:
 *   test/unit/      `*.spec.ts` / `*.spec.tsx`   the unit `test` lane (mirrors `src/`)
 *   test/e2e/       `*.e2e.ts`                   the `e2e` lane (mirrors `src/`)
 *   test/helpers/   support modules a test imports (never collected as tests)
 *   test/fixtures/  data and sample sources a test reads
 *   test/golden/    committed snapshots a test compares against
 *   test/setup.ts   the vitest setup file, when the project has one
 *
 * Rules (each violation carries its rule id):
 *   L1 no test file and no test support directory under `src/`
 *   L2 `test/` holds only the children listed above
 *   L3 file name matches its lane: `test/unit` `*.spec.ts(x)`, `test/e2e` `*.e2e.ts`; no `.test.` suffix
 *   L4 file and directory names under `test/{unit,e2e,helpers}` are lower-case kebab (dots separate qualifiers)
 *   L5 a project with `test/unit` specs takes its vitest `include` from `UNIT_FILE_INCLUDES`
 *   L6 a `tsconfig.spec.json` includes `test/` (a project with none is ratcheted by lane-reachability rule 6)
 *   L7 a file under `src/` never imports from `test/` (production code, and the build that compiles it, cannot depend on tests)
 *
 * Exit code is the only signal (0 = conforming, 1 = violations, 2 = the walker found nothing to scan).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globScan } from './glob-exclusions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

/** Projects whose tests follow a native toolchain layout (Maven `src/test/java`), not this one. */
export const NATIVE_LAYOUT_PROJECTS = Object.freeze(['packages/apigen/java']);

/** The only entries allowed directly under `<project>/test/`. */
export const TEST_DIR_CHILDREN = Object.freeze(['unit', 'e2e', 'helpers', 'fixtures', 'golden', 'setup.ts']);

const SUPPORT_DIRS_IN_SRC = ['test', 'tests', '__tests__', 'test-support'];
const TEST_FILE = /\.(spec|test|e2e)\.[cm]?[jt]sx?$/;
/** Build artifacts a toolchain regenerates next to its inputs (git ignores them); they are not tests. */
const IGNORED_ARTIFACT = /(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$/;
const KEBAB_SEGMENT = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Project roots (repo-relative) that this layout governs. */
export function listProjects(workspaceRoot) {
  return globScan(workspaceRoot, '{packages/**,entrypoint/*}/project.json')
    .map((rel) => dirname(rel))
    .filter((root) => existsSync(join(workspaceRoot, root, 'package.json')) && !NATIVE_LAYOUT_PROJECTS.includes(root))
    .sort();
}

/** Files (not directories) under `dir`, relative to it. Empty directories carry no test, so they are invisible. */
function filesUnder(dir) {
  return globScan(dir, '**/*').filter((rel) => !IGNORED_ARTIFACT.test(rel) && statSync(join(dir, rel)).isFile());
}

function stemOf(name) {
  return name.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Collect layout violations for the whole workspace.
 * @param {string} workspaceRoot absolute repository root
 * @returns {{ violations: { rule: string, file: string, detail: string }[], projects: number, testFiles: number }}
 */
export function collectLayoutViolations(workspaceRoot) {
  const violations = [];
  const add = (rule, file, detail) => violations.push({ rule, file, detail });
  const projects = listProjects(workspaceRoot);
  let testFiles = 0;

  for (const root of projects) {
    const abs = join(workspaceRoot, root);

    // L1 — nothing test-shaped under src/
    for (const rel of globScan(abs, 'src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}')) {
      if (rel.includes('__files__')) continue;
      if (TEST_FILE.test(rel)) add('L1', `${root}/${rel}`, 'test file under src/; tests live in test/unit or test/e2e');
    }
    for (const dir of SUPPORT_DIRS_IN_SRC) {
      if (existsSync(join(abs, 'src', dir)) && filesUnder(join(abs, 'src', dir)).length > 0) {
        add('L1', `${root}/src/${dir}`, `test support directory under src/; use test/helpers, test/fixtures or test/golden`);
      }
    }
    for (const rel of globScan(abs, 'src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}')) {
      if (rel.includes('__files__')) continue;
      const text = readFileSync(join(abs, rel), 'utf8');
      if (/(?:from|import|require)\s*\(?\s*['"](?:\.\.?\/)+test\//.test(text)) add('L7', `${root}/${rel}`, 'src/ imports from test/; move the shared module into src/');
    }
    for (const f of ['src/test-setup.ts', 'src/test-setup.js']) {
      if (existsSync(join(abs, f))) add('L1', `${root}/${f}`, 'vitest setup file under src/; use test/setup.ts');
    }

    const testDir = join(abs, 'test');
    if (!existsSync(testDir)) continue;

    // L2 — closed set of children
    const children = new Set(filesUnder(testDir).map((rel) => rel.split('/')[0]));
    for (const entry of children) {
      if (!TEST_DIR_CHILDREN.includes(entry)) add('L2', `${root}/test/${entry}`, `unexpected entry under test/; allowed: ${TEST_DIR_CHILDREN.join(', ')}`);
    }

    // L3 + L4 — names by lane
    for (const [lane, ok, want] of [
      ['unit', /\.spec\.tsx?$/, '*.spec.ts or *.spec.tsx'],
      ['e2e', /\.e2e\.ts$/, '*.e2e.ts'],
    ]) {
      for (const rel of filesUnder(testDir).filter((r) => r.startsWith(`${lane}/`))) {
        if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
        testFiles += 1;
        const base = rel.split('/').pop();
        if (/\.test\.[cm]?[jt]sx?$/.test(base)) add('L3', `${root}/test/${rel}`, `\`.test\` suffix; the suffix is ${want}`);
        else if (!ok.test(base)) add('L3', `${root}/test/${rel}`, `in test/${lane}/ but not named ${want}`);
      }
    }
    for (const lane of ['unit', 'e2e', 'helpers']) {
      for (const rel of filesUnder(testDir).filter((r) => r.startsWith(`${lane}/`))) {
        if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
        const segments = rel.split('/');
        for (let i = 0; i < segments.length; i += 1) {
          const seg = i === segments.length - 1 ? stemOf(segments[i]) : segments[i];
          if (!KEBAB_SEGMENT.test(seg) && !(i === 0 && seg === lane)) {
            add('L4', `${root}/test/${rel}`, `\`${segments[i]}\` is not lower-case kebab (a-z, 0-9, '-' and '.')`);
            break;
          }
        }
      }
    }

    // L5 + L6 — config reaches the layout
    const hasUnit = globScan(testDir, 'unit/**/*.spec.ts*').length > 0;
    const hasAny = hasUnit || globScan(testDir, 'e2e/**/*.e2e.ts').length > 0;
    if (hasUnit) {
      const cfg = ['vite.config.ts', 'vite.config.mts'].find((c) => existsSync(join(abs, c)));
      const text = cfg ? readFileSync(join(abs, cfg), 'utf8') : '';
      if (!/include:\s*UNIT_FILE_INCLUDES/.test(text)) add('L5', `${root}/${cfg ?? 'vite.config.ts'}`, 'test.include must be UNIT_FILE_INCLUDES (tools/vite-plugins/e2e-globs.mjs)');
    }
    if (hasAny) {
      const specTs = join(abs, 'tsconfig.spec.json');
      if (existsSync(specTs)) {
        const inc = JSON.parse(readFileSync(specTs, 'utf8')).include ?? [];
        if (!inc.some((g) => g.startsWith('test/'))) add('L6', `${root}/tsconfig.spec.json`, 'include must reach test/**/*.ts');
      }
    }
  }
  return { violations, projects: projects.length, testFiles };
}

function main() {
  const { violations, projects, testFiles } = collectLayoutViolations(REPO_ROOT);
  if (projects === 0 || testFiles === 0) {
    console.error(`✖ test layout: the walker scanned ${projects} project(s) and ${testFiles} test file(s); it is broken.`);
    process.exit(2);
  }
  if (violations.length > 0) {
    console.error(`✖ test layout: ${violations.length} violation(s) (docs/standards/testing.md, "Test file layout"):`);
    for (const v of violations) console.error(`   [${v.rule}] ${v.file} — ${v.detail}`);
    process.exit(1);
  }
  console.log(`✓ test layout OK — ${projects} projects, ${testFiles} test files conform.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
