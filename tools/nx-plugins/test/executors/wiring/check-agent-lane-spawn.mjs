#!/usr/bin/env node
/**
 * check-agent-lane-spawn — the machine gate that keeps SUBPROCESS-spawning tests
 * out of the agent family's unit `test` lane (backlog 5b839b90 AC2).
 *
 * THE CLASS. An agent-family unit test that really spawns a process (a stdio MCP
 * server via `npx`/`uvx`/`srt`, a built bin via `child_process`) is slow,
 * load-sensitive, and depends on the host. 2026-10 it timed out under a full
 * `nx affected -t test` and blocked publishing agent-engine-orchestrator
 * (native-tooling-caller-cwd.test.ts). The lane model (docs/PIPELINE.md §2,
 * docs/decisions/0009-test-lanes-unit-vs-e2e.md) is: unit `test` = no subprocess;
 * `e2e` = subprocess / real servers, `--parallel=1`, its own pipeline stage (never in `nx test`).
 *
 * WHAT IT CHECKS (any violation => exit 1). A UNIT-LANE file is any
 * `src/**\/*.{test,spec}.*` in an agent-family project that does NOT match the
 * e2e globs in `tools/vite-plugins/e2e-globs.mjs`.
 *   A. (spawn-in-unit-lane) A unit-lane file, with comments stripped, that
 *      - imports/requires `child_process` (static, `require`, or dynamic import)
 *        WITHOUT a `vi.mock` of it (a mocked `child_process` spawns nothing), or
 *      - references the real stdio transports `StdioClientTransport` /
 *        `StdioMcpClient` as code beyond an import or a `vi.spyOn(X.prototype, …)`
 *        stub (neither constructs nor connects, so neither spawns), or
 *      - declares a stdio MCP server config on a real executable
 *        (`process.execPath` / `sh` / `bash` / `node`) AND connects it
 *        (`new McpClientRegistry(` / `verifyAgentMcpServers(`).
 *   B. (pending-move-stale) `agent-lane-spawn.baseline.json` `pendingMove` lists
 *      files known to spawn through the real engine path (a stdio server config
 *      driven through the Orchestrator) that static scanning cannot prove. Each
 *      must still exist in the unit lane; once moved/renamed the entry must be
 *      removed (the ratchet can only shrink).
 *   C. (e2e-test-not-excluded-from-unit) A project that ships `*.e2e.test.ts`
 *      files must keep them out of its unit lane: its `vite.config.ts` must
 *      reference `E2E_FILE_EXCLUDES` (otherwise vitest's `*.test.ts` include
 *      runs them in BOTH lanes).
 *
 * Agent family = packages/agent/*, entrypoint/agent-mcp, entrypoint/dispatch-cli.
 *
 * Exit code is the only signal (0 = clean, 1 = violation), per the repo's
 * verification standard. Invoked unconditionally by check-lane-reachability.mjs
 * (rule 8), which the pre-push hook and both CI workflows run.
 *
 * `--workspace-root <dir>` points the scan at a fixture workspace; `--baseline <file>`
 * overrides agent-lane-spawn.baseline.json (fixture runs).
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const BASELINE_PATH = join(HERE, 'agent-lane-spawn.baseline.json');

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/**'];
const E2E_FILE = /\.e2e(\.test)?\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Project roots that make up the agent family. */
export function agentFamilyRoots(workspaceRoot) {
  const roots = globSync('packages/agent/*/project.json', { cwd: workspaceRoot, ignore: IGNORE }).map(dirname);
  for (const r of ['entrypoint/agent-mcp', 'entrypoint/dispatch-cli']) {
    if (existsSync(join(workspaceRoot, r, 'project.json'))) roots.push(r);
  }
  return roots.sort();
}

/** Remove block and line comments so a docstring mentioning `child_process` is not a hit. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Why `src` (comment-stripped) spawns a real process, or `undefined`. */
export function spawnReason(rawSrc) {
  const src = stripComments(rawSrc);
  const mocksChildProcess = /vi\.mock\(\s*['"](node:)?child_process['"]/.test(src);
  if (
    !mocksChildProcess &&
    (/from\s+['"](node:)?child_process['"]/.test(src) ||
      /require\(\s*['"](node:)?child_process['"]\s*\)/.test(src) ||
      /import\(\s*['"](node:)?child_process['"]\s*\)/.test(src))
  ) {
    return 'imports child_process (not vi.mock-ed)';
  }
  // A bare import or a `vi.spyOn(X.prototype, ...)` stub references the class
  // without constructing or connecting it, so neither spawns anything. Strip
  // those two shapes; any remaining reference (`new X(`, `X.create(`, ...) is real.
  const STDIO = '(?:StdioClientTransport|StdioMcpClient)';
  const referenced = src
    .replace(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, (imp) => imp.replace(new RegExp(`\\b${STDIO}\\b`, 'g'), ''))
    .replace(new RegExp(`vi\\.spyOn\\(\\s*${STDIO}\\.prototype\\s*,`, 'g'), 'vi.spyOn(__stubbed__,');
  const m = referenced.match(new RegExp(`\\b(${STDIO})\\b`));
  if (m) return `uses the real stdio transport ${m[1]}`;
  // A stdio MCP server config whose command is a REAL local executable (the host
  // node binary, sh, bash, node) in a file that CONNECTS it (constructs a
  // McpClientRegistry / calls verifyAgentMcpServers) — that spawns it. A file that
  // only builds/resolves such configs as data connects nothing and is not matched. Placeholder commands ('noop', 'npx', 'uvx'
  // used as inert config data) are deliberately not matched.
  if (
    /\b(new\s+McpClientRegistry|verifyAgentMcpServers)\s*\(/.test(src) &&
    /transport:\s*['"]stdio['"][\s\S]{0,80}?command:\s*(process\.execPath|['"](sh|bash|node)['"])/.test(src)
  ) {
    return 'declares a stdio MCP server on a real executable (spawned when connected)';
  }
  return undefined;
}

export function collectAgentLaneSpawnViolations(workspaceRoot, baselineOverride) {
  const violations = [];
  const add = (rule, detail) => violations.push({ rule, detail });
  const roots = agentFamilyRoots(workspaceRoot);
  let scanned = 0;
  const unitFiles = new Set();

  for (const root of roots) {
    const files = globSync('src/**/*.*', { cwd: join(workspaceRoot, root), ignore: IGNORE });
    let hasE2eTestFiles = false;
    for (const f of files) {
      if (!TEST_FILE.test(f) && !E2E_FILE.test(f)) continue;
      const rel = `${root}/${f}`;
      if (E2E_FILE.test(f)) {
        if (/\.e2e\.test\./.test(f)) hasE2eTestFiles = true;
        continue;
      }
      unitFiles.add(rel);
      scanned += 1;
      const why = spawnReason(readFileSync(join(workspaceRoot, rel), 'utf8'));
      if (why) {
        add(
          'A-spawn-in-unit-lane',
          `${rel} — unit-lane test ${why}. Subprocess tests belong in the \`e2e\` lane: rename to \`*.e2e.test.ts\` (docs/decisions/0009-test-lanes-unit-vs-e2e.md; backlog 5b839b90 AC2).`,
        );
      }
    }
    if (hasE2eTestFiles) {
      // A project's vite config may be `.ts` or `.mts` (0ba70e47 AC3b: a config
      // that needs ESM-only `import.meta.dirname` / ESM plugins must be `.mts`).
      // When BOTH exist, both are read (union): either may carry the exclude.
      const text = ['vite.config.ts', 'vite.config.mts']
        .map((n) => join(workspaceRoot, root, n))
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      if (!/E2E_FILE_EXCLUDES/.test(text)) {
        add(
          'C-e2e-test-not-excluded-from-unit',
          `${root} — ships *.e2e.test.ts but its vite config (vite.config.ts or .mts) does not exclude \`E2E_FILE_EXCLUDES\` (tools/vite-plugins/e2e-globs.mjs) from \`test.exclude\`, so they also run in the unit lane.`,
        );
      }
    }
  }

  const baseline =
    baselineOverride ?? (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { pendingMove: [] });
  for (const rel of baseline.pendingMove ?? []) {
    if (!existsSync(join(workspaceRoot, rel)) || E2E_FILE.test(rel) || !unitFiles.has(rel)) {
      add('B-pending-move-stale', `${rel} — listed in agent-lane-spawn.baseline.json pendingMove but no longer a unit-lane file (moved, renamed or deleted); remove the entry.`);
    }
  }

  if (roots.length > 0 && scanned === 0) {
    add('A-scan-found-nothing', `${workspaceRoot} — agent-family projects found but ZERO unit-lane test files scanned; the walker is broken.`);
  }
  return { violations, scanned, roots };
}

function main() {
  const i = process.argv.indexOf('--workspace-root');
  const workspaceRoot = i >= 0 ? resolve(process.argv[i + 1]) : REPO_ROOT;
  const b = process.argv.indexOf('--baseline');
  const baseline = b >= 0 ? JSON.parse(readFileSync(resolve(process.argv[b + 1]), 'utf8')) : undefined;
  const { violations, scanned, roots } = collectAgentLaneSpawnViolations(workspaceRoot, baseline);
  if (violations.length > 0) {
    console.error('✖ agent lane-spawn check FAILED — subprocess tests are in the unit lane:');
    for (const v of violations) console.error(`  [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(`✔ agent lane-spawn check passed (${roots.length} projects, ${scanned} unit-lane test files scanned).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
