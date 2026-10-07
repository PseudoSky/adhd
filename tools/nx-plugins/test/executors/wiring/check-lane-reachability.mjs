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
 *     the whole heavy lane UNCACHED on every push). As of 2026-10-07, `publish`
 *     no longer reaches `e2e` either (owner decision); `e2e` must be run explicitly
 *     via the CI gate when needed.
 *
 * This script is the ratchet that makes both classes impossible to reintroduce
 * unnoticed. It is run UNCONDITIONALLY by the pre-push hook and both CI
 * workflows, before the lanes, so a mis-wired gate fails in seconds.
 *
 * RULES (any violation => exit 1):
 *   1. A project that ships `src/**\/*.e2e.ts` or `src/**\/*.e2e.test.ts` MUST declare an `e2e` target
 *      (otherwise its heavy suites are dead config).
 *   2. NO project's `test.dependsOn` may contain `e2e` (the coupling that made
 *      the heavy lane run uncached on every `nx affected -t test` — re-adding it
 *      defeats the separation).
 *   3. Every `e2e` target MUST be `cache: true` with non-empty `inputs`
 *      containing `default` (so the gate reaches it without re-running it
 *      uncached every time — the whole point of the separation).
 *   4. For every PUBLISHABLE project, `publish` must NOT depend on `e2e`
 *      (owner decision 2026-10-07). Verified by invoking the plugin's OWN
 *      `createNodes` and reading the resolved `publish.dependsOn` (never a
 *      re-implementation — a re-implementation would stay green when the
 *      plugin breaks, defeating the check).
 *   5. Both CI workflows (`.github/workflows/pull-request.yml`, `ci.yml`) MUST
 *      invoke every target in `GATE_TARGETS` (imported from `tools/gate/lane-gate.mjs`).
 *      `.githooks/pre-push` runs `test` but NOT `e2e` (too heavy per push; CI and the
 *      AGENTS.md pre-push gate cover it): it must DERIVE its flags from
 *      `.githooks/lib/pre-push-flags.mjs` (GATE_TARGETS minus PRE_PUSH_EXCLUDED), must
 *      not reference `lane-gate.mjs` or name `e2e` itself, and the resolved target
 *      list must contain `test` and no `e2e`.
 *   6. Every project with a `tsconfig.spec.json` MUST have a target that
 *      COMPILES it (surfaces its type errors). This is a pre-existing,
 *      workspace-wide gap (only `entrypoint/backlog` wires `typecheck-spec`);
 *      it is RATCHETED against `lane-reachability.baseline.json` so the check is
 *      green today and can only shrink — a new un-wired `tsconfig.spec.json`
 *      fails, and a baselined project that gets wired must be removed from the
 *      baseline.
 *   7. Every `vite.config.ts` (and generator `vite.config.ts__tmpl__`) declares
 *      exactly ONE `plugins:` key and contains every imported vite-plugin
 *      factory in that array — the whole-workspace class guard for 50b77657,
 *      run unconditionally here so an unrelated package's duplicate key cannot
 *      escape `nx affected -t test` (47557842). Delegated to
 *      `check-vite-config-plugins.mjs` (one implementation).
 *
 *   8. No agent-family (packages/agent/*, entrypoint/agent-mcp, entrypoint/dispatch-cli)
 *      UNIT-lane test spawns a subprocess (child_process / StdioClientTransport /
 *      StdioMcpClient / a real-executable stdio MCP server), and every project that
 *      ships `*.e2e.test.ts` excludes them from its unit lane. Delegated to
 *      `check-agent-lane-spawn.mjs` (backlog 5b839b90 AC2).
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
import { collectViteConfigPluginViolations } from './check-vite-config-plugins.mjs';
import { collectAgentLaneSpawnViolations } from './check-agent-lane-spawn.mjs';
import { E2E_FILE_INCLUDES } from '../../../../vite-plugins/e2e-globs.mjs';

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

const PRE_PUSH_FILE = '.githooks/pre-push';

/** The targets the REAL pre-push hook resolves (`.githooks/lib/pre-push-flags.mjs`). */
export async function loadPrePushTargets() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, '.githooks/lib/pre-push-flags.mjs')).href);
  return mod.prePushTargets();
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
function fileInvokesTarget(text, t, { canonical = true } = {}) {
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
  if (canonical && /lane-gate\.mjs/.test(body) && /\bnode\b/.test(body)) return true;
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
export async function runChecks({ workspaceRoot, gateTargets, createNodesFn, baseline: baselineOverride, agentLaneBaseline, prePushTargets: prePushOverride }) {
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
    const e2eFiles = globSync(E2E_FILE_INCLUDES, {
      cwd: join(workspaceRoot, p.root),
      ignore: ['**/node_modules/**'],
    });
    if (e2eFiles.length > 0 && !(p.json.targets && p.json.targets.e2e)) {
      add('1-e2e-files-without-target', `${p.root} — ${e2eFiles.length} src/**/*.e2e.ts / *.e2e.test.ts file(s) but no \`e2e\` target (dead config).`);
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

  // ---- rule 4: publish must not depend on e2e (owner decision 2026-10-07) -----
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
    const reachesE2e = dependsOnTargets(publish.dependsOn).includes('e2e');
    if (reachesE2e === true) {
      add(
        '4-publish-reaches-e2e',
        `${root} — \`publish.dependsOn\` reaches e2e (resolved: ${JSON.stringify(publish.dependsOn)}). ` +
          `publish must not depend on e2e (owner decision 2026-10-07). Remove e2e from tools/nx-plugins/build/plugin.js or this project's nx-release-publish override.`,
      );
    }
  }

  // ---- rule 5: CI gate files invoke every GATE_TARGETS; pre-push runs test, not e2e
  const prePushTargets = prePushOverride ?? (await loadPrePushTargets());
  for (const rel of GATE_FILES) {
    const abs = join(workspaceRoot, rel);
    if (!existsSync(abs)) {
      add('5-gate-file-missing', `${rel} — gate file not found.`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    if (rel === PRE_PUSH_FILE) {
      const body = text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      if (!/pre-push-flags\.mjs/.test(body)) {
        add(
          '5-gate-not-canonical',
          `${rel} — must DERIVE its flags from .githooks/lib/pre-push-flags.mjs (GATE_TARGETS minus PRE_PUSH_EXCLUDED), not hard-code \`--target=…\`.`,
        );
      }
      for (const t of gateTargets.filter((g) => !prePushTargets.includes(g))) {
        if (fileInvokesTarget(text, t, { canonical: false }) || /\bnode\b[^\n]*lane-gate\.mjs/.test(body)) {
          add('5-pre-push-runs-e2e', `${rel} — runs the full gate (names \`${t}\` or reads lane-gate.mjs directly); pre-push must run GATE_TARGETS minus PRE_PUSH_EXCLUDED via pre-push-flags.mjs.`);
          break;
        }
      }
      if (!prePushTargets.includes('test')) {
        add('5-pre-push-missing-test', `${rel} — resolved pre-push targets [${prePushTargets.join(', ')}] do not include \`test\`.`);
      }
      for (const t of prePushTargets.filter((x) => x === 'e2e')) {
        add('5-pre-push-runs-e2e', `${rel} — resolved pre-push targets [${prePushTargets.join(', ')}] include \`${t}\`; the local hook must not run e2e (CI does).`);
      }
      continue;
    }
    for (const t of gateTargets) {
      if (!fileInvokesTarget(text, t)) {
        add('5-gate-file-missing-target', `${rel} — does not invoke target \`${t}\` (GATE_TARGETS from tools/gate/lane-gate.mjs).`);
      }
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

  // ---- rule 7: every vite.config.ts has exactly ONE plugins array ---------
  // Hosted HERE (not in a package's vitest suite) because a whole-workspace
  // invariant must not be gated on one project's nx-affected membership
  // (backlog 47557842): the sweep used to live in agent-engine-orchestrator, so
  // a duplicate `plugins:` key reintroduced in an unrelated package escaped
  // `nx affected -t test` entirely. This check is run UNCONDITIONALLY by the
  // pre-push hook and both CI workflows, ahead of the lanes and independent of
  // the affected graph. A workspace with project.json files but ZERO configs
  // scanned is itself flagged — a dead walker must fail loudly, not pass empty.
  const hasProjects = globSync(['packages/**/project.json', 'entrypoint/**/project.json'], {
    cwd: workspaceRoot,
    ignore: IGNORE,
  }).length > 0;
  const vite = collectViteConfigPluginViolations(workspaceRoot);
  if (hasProjects && vite.scanned === 0) {
    add('7-vite-sweep-found-nothing', `${workspaceRoot} — discovered project.json files but ZERO vite.config.ts files; the sweep walker is broken.`);
  }
  for (const v of vite.violations) add(v.rule, v.detail);

  // ---- rule 8: no subprocess-spawning test in an agent-family UNIT lane -----
  // backlog 5b839b90 AC2. Delegated to check-agent-lane-spawn.mjs (one
  // implementation; rules A/B/C there). Unconditional, like rule 7, so it does
  // not depend on nx-affected membership.
  for (const v of collectAgentLaneSpawnViolations(workspaceRoot, agentLaneBaseline).violations) {
    add(`8-${v.rule}`, v.detail);
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
    console.error('  The gate runs GATE_TARGETS from tools/gate/lane-gate.mjs; both CI workflows must reach');
    console.error('  every target (pre-push runs test, never e2e), every `e2e` lane must be cached, `test` must not re-couple `e2e`,');
    console.error('  `publish` does not depend on `e2e` (owner decision 2026-10-07), and every');
    console.error('  `vite.config.ts` must declare exactly ONE `plugins:` array (check-vite-config-plugins.mjs).');
    process.exit(1);
  }

  console.log(`✓ lane reachability OK — gate targets [${gateTargets.join(', ')}]; CI workflows reach them, pre-push runs test without e2e; every e2e lane cached; publish does not depend on e2e; every vite.config.ts single-array.`);
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
