#!/usr/bin/env node
/**
 * check-lane-reachability — the machine check that keeps the push/CI gate's
 * resource-heavy lane reachable and cached.
 *
 * WHY THIS EXISTS. The gate runs `test` + `e2e` over the affected closure
 * (`.githooks/pre-push` and both CI workflows; the single canonical list is
 * `tools/gate/lane-gate.mjs`). That wiring is easy to break silently:
 *
 *   - 2026-09-26 (backlog 98142eab, instance 2) the `.e2e.ts` lane was dead
 *     config — it appeared in NO target's `dependsOn` and ran in NO pipeline, so
 *     a regression in any of them reported green.
 *   - 2026-09-28 (backlog-e2e-cache-separation) `e2e` was removed from
 *     `entrypoint/backlog`'s `test.dependsOn` (correctly — coupling it there ran
 *     the whole heavy lane UNCACHED on every push), which moved the burden of
 *     reaching it onto the gate files. A gate file left naming only `test` would
 *     let a broken heavy lane ship — or get published.
 *
 * This script is the ratchet that makes both classes impossible to reintroduce
 * unnoticed. It is run UNCONDITIONALLY by the pre-push hook and both CI
 * workflows, before the lanes, so a mis-wired gate fails in seconds.
 *
 * RULES (any violation => exit 1):
 *   1. A project that ships `src/**\/*.e2e.ts` MUST declare an `e2e` target
 *      (otherwise its heavy suites are dead config).
 *   2. NO project's `test.dependsOn` may contain `e2e` (the coupling that made
 *      the heavy lane run uncached on every `nx affected -t test` — re-adding it
 *      defeats the separation).
 *   3. Every `e2e` target MUST be `cache: true` with non-empty `inputs`
 *      containing `default` (so the gate reaches it without re-running it
 *      uncached every time — the whole point of the separation).
 *   4. For every PUBLISHABLE project, its declaration of an `e2e` target MUST
 *      agree with `publish` reaching `e2e` — i.e. the conditional in
 *      `tools/nx-plugins/build/plugin.js` (`hasE2e ? ["e2e"] : []`) is intact,
 *      so a broken heavy suite can never be published green. Verified by
 *      invoking the plugin's OWN `createNodes` and reading the resolved
 *      `publish.dependsOn` (never a re-implementation — a re-implementation
 *      would stay green when the plugin breaks, defeating the check).
 *   5. Every gate file (`.githooks/pre-push`, `.github/workflows/pull-request.yml`,
 *      `.github/workflows/ci.yml`) MUST invoke every target in `GATE_TARGETS`
 *      (imported from `tools/gate/lane-gate.mjs`). `.githooks/pre-push` must
 *      additionally DERIVE its flags from that module, not hard-code them.
 *   6. Every project with a `tsconfig.spec.json` MUST have a target that
 *      COMPILES it (surfaces its type errors). This is a pre-existing,
 *      workspace-wide gap (only `entrypoint/backlog` wires `typecheck-spec`);
 *      it is RATCHETED against `lane-reachability.baseline.json` so the check is
 *      green today and can only shrink — a new un-wired `tsconfig.spec.json`
 *      fails, and a baselined project that gets wired must be removed from the
 *      baseline.
 *
 * Exit code is the only signal (0 = wired, 1 = gap found), per the repo's
 * verification standard — never grep stdout for "passed".
 *
 * TESTABILITY. `--workspace-root <dir>` points the project/gate scans at a
 * fixture workspace (the plugin is still imported from THIS repo, so rule 4
 * tests the real plugin). `--write-baseline` regenerates rule 6's baseline.
 */
import { globSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
// tools/nx-plugins/test/executors/wiring -> repo root
const REPO_ROOT = resolve(HERE, '../../../../..');
const BASELINE_PATH = join(HERE, 'lane-reachability.baseline.json');

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/**'];

/** The three files that run the gate. Rule 5 audits all of them. */
export const GATE_FILES = [
  '.githooks/pre-push',
  '.github/workflows/pull-request.yml',
  '.github/workflows/ci.yml',
];

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function loadGateTargets() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'tools/gate/lane-gate.mjs')).href);
  return mod.GATE_TARGETS;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function dependsOnTargets(dependsOn) {
  if (!Array.isArray(dependsOn)) return [];
  return dependsOn
    .map((d) => (typeof d === 'string' ? d : d && typeof d === 'object' ? d.target : undefined))
    .filter((x) => typeof x === 'string');
}

/**
 * Does `text` (a gate file's body, comment lines stripped) invoke target `t`?
 * Recognizes `--target=<t>`, the `-t <space-separated list>` form, and a
 * canonical-module reference (a `node … lane-gate.mjs` invocation produces the
 * whole `GATE_TARGETS` list at runtime).
 */
function fileInvokesTarget(text, t) {
  const body = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (new RegExp(`--target=${t}\\b`).test(body)) return true;
  const listLines = body.match(/(?:^|\s)-t\s+[^\n]*/g) ?? [];
  if (listLines.some((line) => new RegExp(`(?:^|\\s)${t}(?:\\s|$)`).test(line))) return true;
  // `-t` may also be written as `--targets=`; cover that too.
  const multiLines = body.match(/--targets=[^\n]*/g) ?? [];
  if (multiLines.some((line) => new RegExp(`(?:=|,)${t}(?:,|\\s|$)`).test(line))) return true;
  // Canonical module: the flags are produced from lane-gate.mjs at runtime.
  if (/lane-gate\.mjs/.test(body) && /\bnode\b/.test(body)) return true;
  return false;
}

/**
 * Run every rule against `workspaceRoot`. Returns `{ violations, newGapProjects }`
 * where `newGapProjects` is the rule-6 gap set (for `--write-baseline`).
 *
 * `createNodesFn` is injectable ONLY so a spec can prove rule 4 has teeth by
 * injecting a deliberately-broken plugin; production always passes the REAL
 * plugin (see `main`).
 */
export async function runChecks({ workspaceRoot, gateTargets, createNodesFn, baseline: baselineOverride }) {
  const violations = [];
  const add = (rule, detail) => violations.push({ rule, detail });

  // ---- enumerate projects -------------------------------------------------
  const projectJsonRel = globSync(['packages/**/project.json', 'entrypoint/**/project.json'], {
    cwd: workspaceRoot,
    ignore: IGNORE,
  });
  const projects = projectJsonRel.map((rel) => {
    const root = dirname(rel);
    const jsonPath = join(workspaceRoot, rel);
    const raw = readFileSync(jsonPath, 'utf8');
    return { root, jsonPath, raw, json: JSON.parse(raw) };
  });

  // ---- rule 1: e2e files => e2e target -----------------------------------
  for (const p of projects) {
    const e2eFiles = globSync('src/**/*.e2e.ts', {
      cwd: join(workspaceRoot, p.root),
      ignore: ['**/node_modules/**'],
    });
    if (e2eFiles.length > 0 && !(p.json.targets && p.json.targets.e2e)) {
      add('1-e2e-files-without-target', `${p.root} — ${e2eFiles.length} src/**/*.e2e.ts file(s) but no \`e2e\` target (dead config).`);
    }
  }

  // ---- rule 2: test.dependsOn must not contain e2e -----------------------
  for (const p of projects) {
    const testDep = p.json.targets && p.json.targets.test && p.json.targets.test.dependsOn;
    if (dependsOnTargets(testDep).includes('e2e')) {
      add('2-test-depends-on-e2e', `${p.root} — \`test.dependsOn\` contains \`e2e\`; this re-couples the heavy lane into every \`nx affected -t test\`. Remove it (the gate reaches e2e directly).`);
    }
  }

  // ---- rule 3: every e2e target is cached with inputs --------------------
  for (const p of projects) {
    const e2e = p.json.targets && p.json.targets.e2e;
    if (!e2e) continue;
    const cached = e2e.cache === true;
    const inputs = Array.isArray(e2e.inputs) ? e2e.inputs : [];
    const hasDefault = inputs.includes('default');
    if (!cached || inputs.length === 0 || !hasDefault) {
      add(
        '3-e2e-not-cached',
        `${p.root} — \`e2e\` must be \`cache: true\` with non-empty \`inputs\` containing \`default\` ` +
          `(cache=${e2e.cache ?? 'unset'}, inputs=${JSON.stringify(e2e.inputs ?? null)}) so the gate does not re-run the heavy lane uncached.`,
      );
    }
  }

  // ---- rule 4: publishable project's publish reaches its e2e -------------
  // Invoke the REAL build plugin's createNodes and read its resolved output —
  // never a re-implementation (a re-implementation would stay green when the
  // plugin itself breaks).
  const buildPlugin = require(join(REPO_ROOT, 'tools/nx-plugins/build/plugin.js'));
  const resolveNodes =
    createNodesFn ??
    ((configFiles) => buildPlugin.createNodes[1](configFiles, {}, { workspaceRoot }));
  const pkgRel = globSync(['packages/**/package.json', 'entrypoint/**/package.json'], {
    cwd: workspaceRoot,
    ignore: IGNORE,
  });
  const results = resolveNodes(pkgRel);
  for (const [pkgPath, result] of results) {
    const root = dirname(pkgPath);
    const resolved = result && result.projects && result.projects[root];
    const publish = resolved && resolved.targets && resolved.targets.publish;
    if (!publish) continue; // plugin did not attach a publish target (not buildable/publishable)
    const project = projects.find((p) => p.root === root);
    const declaresE2e = Boolean(project && project.json.targets && project.json.targets.e2e);
    const reachesE2e = dependsOnTargets(publish.dependsOn).includes('e2e');
    if (declaresE2e !== reachesE2e) {
      add(
        '4-publish-e2e-disagreement',
        `${root} — declares \`e2e\`=${declaresE2e} but \`publish.dependsOn\` reaches e2e=${reachesE2e} ` +
          `(resolved: ${JSON.stringify(publish.dependsOn)}). The conditional in tools/nx-plugins/build/plugin.js is broken.`,
      );
    }
  }

  // ---- rule 5: gate files invoke every GATE_TARGETS ----------------------
  for (const rel of GATE_FILES) {
    const abs = join(workspaceRoot, rel);
    if (!existsSync(abs)) {
      add('5-gate-file-missing', `${rel} — gate file not found.`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    for (const t of gateTargets) {
      if (!fileInvokesTarget(text, t)) {
        add('5-gate-file-missing-target', `${rel} — does not invoke target \`${t}\` (GATE_TARGETS from tools/gate/lane-gate.mjs).`);
      }
    }
    if (rel === '.githooks/pre-push' && !/lane-gate\.mjs/.test(text)) {
      add(
        '5-gate-not-canonical',
        `${rel} — must DERIVE its flags from tools/gate/lane-gate.mjs (not hard-code \`--target=…\`), so the hook and CI cannot drift.`,
      );
    }
  }

  // ---- rule 6: tsconfig.spec.json has a compiling target (ratcheted) -----
  const baseline =
    baselineOverride ??
    (existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH) : { tsconfigSpecWithoutCompileTarget: [] });
  const baselined = new Set(baseline.tsconfigSpecWithoutCompileTarget ?? []);
  const gapProjects = [];
  for (const p of projects) {
    if (!existsSync(join(workspaceRoot, p.root, 'tsconfig.spec.json'))) continue;
    // A "compiling target over tsconfig.spec.json" is any target whose config
    // references the file (e.g. entrypoint/backlog's `typecheck-spec`). nx.json's
    // `production` namedInput EXCLUDES tsconfig.spec.json, so an inferred target
    // never covers it — it must be an explicit target.
    const hasCompilingTarget = Object.values(p.json.targets ?? {}).some((t) =>
      JSON.stringify(t).includes('tsconfig.spec.json'),
    );
    const isBaselined = baselined.has(p.root);
    if (hasCompilingTarget && isBaselined) {
      add('6-stale-baseline-entry', `${p.root} — now HAS a compiling target over tsconfig.spec.json; remove it from lane-reachability.baseline.json.`);
    } else if (!hasCompilingTarget && !isBaselined) {
      gapProjects.push(p.root);
      add(
        '6-tsconfig-spec-without-compile-target',
        `${p.root} — has tsconfig.spec.json but no target compiles it, so its spec corpus can carry type errors no gate can see (backlog 98142eab instance 3). Wire a typecheck-spec-style target (see entrypoint/backlog/project.json) or add it to lane-reachability.baseline.json.`,
      );
    } else if (!hasCompilingTarget && isBaselined) {
      gapProjects.push(p.root);
    }
  }

  return { violations, gapProjects };
}

async function main() {
  const workspaceRoot = resolve(argValue('--workspace-root') ?? REPO_ROOT);
  const gateTargets = await loadGateTargets();
  const { violations, gapProjects } = await runChecks({ workspaceRoot, gateTargets });

  if (process.argv.includes('--write-baseline')) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ tsconfigSpecWithoutCompileTarget: [...gapProjects].sort() }, null, 2) + '\n',
    );
    console.log(`✓ wrote ${relative(REPO_ROOT, BASELINE_PATH)} (${gapProjects.length} project(s) without a spec-compile target).`);
    return;
  }

  if (violations.length > 0) {
    console.error('✖ lane reachability check FAILED — the push/CI gate is mis-wired:');
    for (const v of violations) console.error(`   [${v.rule}] ${v.detail}`);
    console.error('');
    console.error('  The gate runs GATE_TARGETS from tools/gate/lane-gate.mjs; every gate file must reach');
    console.error('  every target, every `e2e` lane must be cached, `test` must not re-couple `e2e`, and');
    console.error('  `publish` must reach every declared `e2e` (tools/nx-plugins/build/plugin.js).');
    process.exit(1);
  }

  console.log(`✓ lane reachability OK — gate targets [${gateTargets.join(', ')}]; all gate files reach them; every e2e lane cached; publish reaches every declared e2e.`);
}

// Only run when invoked directly (never when imported by a test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('✖ lane reachability check crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
