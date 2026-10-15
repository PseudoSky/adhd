#!/usr/bin/env node
/**
 * Negative controls for check-spawn-isolation (backlog 0945d1b9 AC1, AC2; decisions D1 + D2).
 *
 * guards: a spec or e2e file in an @adhd/environment-family package that spawns a Node bin (process.execPath, the literal
 *   node, a const alias of either, or fork(module)) without routing HOME per call hands the child the machine's real HOME,
 *   so the child reads and writes the real ~/.adhd; and a ratchet baseline that is not enforced in both directions
 *   (more unrouted sites than recorded, or fewer with the entry left behind) lets the leak grow or the baseline rot.
 * tier: S (pure functions over in-memory source strings, and the real collector over throwaway fixture workspaces under
 *   the tooling scratch root (.adhd/tmp/, via scratchRootPath); no process is spawned, nothing sleeps)
 * cites: 0945d1b9 AC1 (per-site detection and routing forms), 0945d1b9 AC2 (ratchet, stale, invalid, zero-scan, rule 9
 *   fixture contract).
 * red: pending - the owner's hold forbids running tests; against the pre-guard base 21ba12b3 the module
 *   ./check-spawn-isolation.mjs does not exist, so every case in this file fails on import. Against the guard under test every
 *   case below is expected to pass, and each "control" case fails when its detector rule is broken.
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-spawn-isolation.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  BASELINE_REL,
  NODE_SPAWN,
  NON_ISOLATING_EXPORTS,
  collectSpawnIsolationViolations,
  findUnroutedSpawnSites,
  normalizeBaseline,
  scanSource,
  spawnIsolationReason,
} from './check-spawn-isolation.mjs';
import { runChecks } from './check-lane-reachability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
// tooling-layer scratch root: the single canonical definition (AGENTS.md section 10), never a hardcoded path
const { scratchRootPath } = createRequire(import.meta.url)('../../../lib/scratch-root.js');
const SCRATCH_PARENT = scratchRootPath(REPO_ROOT, 'spawn-isolation-spec');

const L = (...lines) => lines.join('\n');
const CP = "import { spawnSync, spawn, fork } from 'node:child_process';";
const count = (src, helpers) => findUnroutedSpawnSites(src, helpers).length;

// ---------------------------------------------------------------------------------------------------------------
// AC1 - detection: what is a spawn site, and per-site routing
// ---------------------------------------------------------------------------------------------------------------

test('AC1 flags a Node-bin spawn with no HOME routing, reporting its line [0945d1b9 AC1]', () => {
  const src = L(CP, '', "spawnSync(process.execPath, [bin], { env: process.env });");
  const sites = findUnroutedSpawnSites(src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 3);
  assert.equal(sites[0].callee, 'spawnSync');
});

for (const callee of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  test(`AC1 flags ${callee}(process.execPath, ...) [0945d1b9 AC1]`, () => {
    assert.equal(count(L(CP, `${callee}(process.execPath, [bin]);`)), 1);
  });
}

test('AC1 flags the literal node executable in each quote style [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, "spawn('node', [bin]);")), 1);
  assert.equal(count(L(CP, 'spawn("node", [bin]);')), 1);
});

test('AC1 flags fork(modulePath) because the child inherits env [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, 'fork(modulePath, []);')), 1);
});

test('AC1 control: a fork routed with HOME is not flagged (fork rule only fires on the unrouted call) [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, 'fork(modulePath, [], { env: { ...process.env, HOME: tmp } });')), 0);
});

test('AC1 flags a const alias of process.execPath and of node [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, 'const NODE = process.execPath;', 'spawnSync(NODE, [bin]);')), 1);
  assert.equal(count(L(CP, "const runner = 'node';", 'spawn(runner, [bin]);')), 1);
});

test('AC1 control: spawning a non-node executable is not a site [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, "spawnSync('git', ['status']);")), 0);
  assert.equal(count(L(CP, "execFileSync('npx', ['nx', 'test']);")), 0);
  assert.equal(count(L(CP, "const GIT = '/usr/bin/git';", 'spawnSync(GIT, []);')), 0);
});

test('AC1 control: a file with no spawn call at all yields no sites [0945d1b9 AC1]', () => {
  assert.deepEqual(findUnroutedSpawnSites("export const x = 1;\n"), []);
});

// ---- routing forms: each equivalence class routes the call --------------------------------------------------

const ROUTED_FORMS = {
  'bare HOME key in the call env': L(CP, 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: tmp } });'),
  "quoted 'HOME' key": L(CP, "spawnSync(process.execPath, [bin], { env: { ...process.env, 'HOME': tmp } });"),
  'double-quoted "HOME" key': L(CP, 'spawnSync(process.execPath, [bin], { env: { ...process.env, "HOME": tmp } });'),
  'shorthand HOME': L(CP, 'const HOME = tmp;', 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME } });'),
  'env object declared above the call carries HOME': L(
    CP,
    'const env = { ...process.env, HOME: tmp };',
    'spawnSync(process.execPath, [bin], { env });',
  ),
  'process.env.HOME assigned before the call at module level': L(
    CP,
    'process.env.HOME = tmp;',
    'spawnSync(process.execPath, [bin]);',
  ),
  'process.env.HOME assigned in a beforeAll hook of the enclosing scope': L(
    CP,
    'beforeAll(() => {',
    '  process.env.HOME = tmp;',
    '});',
    "it('runs the bin', () => {",
    '  spawnSync(process.execPath, [bin]);',
    '});',
  ),
  'named helper import used in the call': L(
    CP,
    "import { isolatedSpawnOptions } from './helpers/spawn-isolated-bin.js';",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  ),
  'second helper (spawn-backlog-bin) used in the call': L(
    CP,
    "import { sandboxArgs } from './spawn-backlog-bin';",
    'spawnSync(process.execPath, [bin, ...sandboxArgs()]);',
  ),
  'renamed helper import used in the call': L(
    CP,
    "import { isolatedSpawnOptions as iso } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], iso());',
  ),
  'namespace helper import, isolating member used': L(
    CP,
    "import * as helper from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], helper.isolatedSpawnOptions());',
  ),
  'helper required with require()': L(
    CP,
    "const { isolatedSpawnOptions } = require('./spawn-isolated-bin');",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  ),
  'helper loaded with await import()': L(
    CP,
    "const { isolatedSpawnOptions } = await import('./helpers/spawn-isolated-bin.js');",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  ),
  'options object spreading an imported helper result (ir-cache.durability shape)': L(
    CP,
    "import { DIST_INDEX, isolatedSpawnOptions } from './test/helpers/spawn-isolated-bin.js';",
    'spawn(process.execPath, [DIST_INDEX], {',
    '  ...isolatedSpawnOptions(root, { stdio: "pipe" }),',
    '});',
  ),
  'single-line spread of an imported helper result': L(
    CP,
    "import { DIST_INDEX, isolatedSpawnOptions } from './test/helpers/spawn-isolated-bin.js';",
    'spawn(process.execPath, [DIST_INDEX], { ...isolatedSpawnOptions(root), cwd: root });',
  ),
  'options identifier declared with helper use': L(
    CP,
    "import { isolatedSpawnOptions } from './spawn-isolated-bin';",
    'const opts = isolatedSpawnOptions();',
    'spawnSync(process.execPath, [bin], opts);',
  ),
};

for (const [form, src] of Object.entries(ROUTED_FORMS)) {
  test(`AC1 routes: ${form} [0945d1b9 AC1]`, () => {
    assert.equal(count(src), 0, `expected routed, got sites ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

// ---- negative controls: break each routing rule and the violation must appear ------------------------------

const BROKEN_FORMS = {
  'HOME set to the real home via process.env.HOME': L(CP, 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: process.env.HOME } });'),
  'HOME set to os.homedir()': L(CP, 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: homedir() } });'),
  'HOME key only inside a comment': L(CP, 'spawnSync(process.execPath, [bin], {', '  env: { ...process.env }, // HOME: tmp', '});'),
  'helper imported but never used in the call': L(
    CP,
    "import { isolatedSpawnOptions } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], { env: process.env });',
  ),
  'only the non-isolating DIST_INDEX imported from the helper': L(
    CP,
    "import { DIST_INDEX } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [DIST_INDEX]);',
  ),
  'namespace helper import, only DIST_INDEX member used': L(
    CP,
    "import * as helper from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [helper.DIST_INDEX]);',
  ),
  'type-only helper import': L(
    CP,
    "import type { isolatedSpawnOptions } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], { env: process.env });',
  ),
  'import from a module that merely resembles a helper name': L(
    CP,
    "import { isolatedSpawnOptions } from './not-spawn-isolated-binary';",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  ),
  'spread of a helper result with the helper import removed (ir-cache.durability shape)': L(
    CP,
    "import { DIST_INDEX } from './test/helpers/spawn-isolated-bin.js';",
    'spawn(process.execPath, [DIST_INDEX], {',
    '  ...isolatedSpawnOptions(root, { stdio: "pipe" }),',
    '});',
  ),
  'spread of a call when only DIST_INDEX is imported from the helper and the spread is another module': L(
    CP,
    "import { DIST_INDEX } from './test/helpers/spawn-isolated-bin.js';",
    "import { plainOptions } from './test/helpers/plain-options.js';",
    'spawn(process.execPath, [DIST_INDEX], { ...plainOptions(root) });',
  ),
  'options identifier declared without HOME': L(CP, 'const env = { ...process.env };', 'spawnSync(process.execPath, [bin], { env });'),
  'process.env.HOME assigned AFTER the call': L(CP, 'spawnSync(process.execPath, [bin]);', 'process.env.HOME = tmp;'),
  'process.env.HOME assigned in a sibling test block that does not enclose the call': L(
    CP,
    "it('a', () => {",
    '  process.env.HOME = tmp;',
    '});',
    "it('b', () => {",
    '  spawnSync(process.execPath, [bin]);',
    '});',
  ),
  'process.env.HOME assigned to the real home': L(CP, 'process.env.HOME = process.env.HOME;', 'spawnSync(process.execPath, [bin]);'),
};

for (const [form, src] of Object.entries(BROKEN_FORMS)) {
  test(`AC1 control (violation appears): ${form} [0945d1b9 AC1]`, () => {
    assert.equal(count(src), 1, `expected one unrouted site, got ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

test('AC1 per-site: a HOME key elsewhere in the file does not route a different spawn [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    'const unrelated = { HOME: tmp };', //                                                  line 2: file-level HOME, never passed
    'spawnSync(process.execPath, [a], { env: { ...process.env, HOME: tmp } });', //          line 3: routed
    'spawnSync(process.execPath, [b], { env: process.env });', //                            line 4: NOT routed
    "spawnSync(process.execPath, [c], { cwd: '/x' });", //                                   line 5: NOT routed
  );
  const sites = findUnroutedSpawnSites(src);
  assert.deepEqual(
    sites.map((s) => s.line),
    [4, 5],
  );
});

test('AC1 per-site control: routing every call clears the file [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    'spawnSync(process.execPath, [a], { env: { ...process.env, HOME: tmp } });',
    'spawnSync(process.execPath, [b], { env: { ...process.env, HOME: tmp } });',
  );
  assert.deepEqual(findUnroutedSpawnSites(src), []);
});

// ---- not-a-site: literals and comments ------------------------------------------------------------------------

test('AC1 a spawn call inside a template literal, string or comment is NOT a site [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    'const script = `',
    "  const { spawn } = require('node:child_process');",
    "  spawn(process.execPath, ['child.js']);",
    '`;',
    "const text = \"spawnSync(process.execPath, ['x'])\";",
    "// spawnSync(process.execPath, ['y']);",
    "/* spawn(process.execPath, ['z']); */",
  );
  assert.deepEqual(findUnroutedSpawnSites(src), []);
});

test('AC1 control: the same text outside a literal IS a site (the literal handling, not the matcher, is what skips) [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, "spawn(process.execPath, ['child.js']);")), 1);
});

test('AC1 an embedded script string does not hide a real spawn after it, and the real one keeps its line [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    "const script = `spawn(process.execPath, ['child.js']);`;",
    "spawnSync(process.execPath, [bin], { env: process.env });",
  );
  const sites = findUnroutedSpawnSites(src);
  assert.deepEqual(
    sites.map((s) => s.line),
    [3],
  );
});

test('AC1 a declaration named like a spawn function is not a call [0945d1b9 AC1]', () => {
  assert.equal(count(L('function fork(a) {', '  return a;', '}')), 0);
});

// ---- helpers option and exports ---------------------------------------------------------------------------------

test('AC1 an empty helpers array routes nothing, the default routes helper use [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    "import { isolatedSpawnOptions } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  );
  assert.equal(count(src), 0);
  assert.equal(count(src, []), 1);
});

test('AC1 a custom helper name routes only when listed in helpers [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    "import { hermetic } from './hermetic-env';",
    'spawnSync(process.execPath, [bin], hermetic());',
  );
  assert.equal(count(src), 1);
  assert.equal(count(src, ['hermetic-env']), 0);
});

test('AC1 NON_ISOLATING_EXPORTS lists the bin path and key lists, never an isolating export [0945d1b9 AC1]', () => {
  assert.ok(NON_ISOLATING_EXPORTS.includes('DIST_INDEX'));
  assert.ok(NON_ISOLATING_EXPORTS.includes('AMBIENT_REDIRECT_ENV_KEYS'));
  assert.ok(!NON_ISOLATING_EXPORTS.includes('isolatedSpawnOptions'));
  assert.ok(!NON_ISOLATING_EXPORTS.includes('buildIsolatedEnv'));
});

test('AC1 spawnIsolationReason is undefined when routed and names the lines when not [0945d1b9 AC1]', () => {
  assert.equal(spawnIsolationReason(L(CP, 'spawnSync(process.execPath, [bin], { env: { HOME: tmp } });')), undefined);
  const reason = spawnIsolationReason(L(CP, '', 'spawnSync(process.execPath, [a]);', 'spawn(process.execPath, [b]);'));
  assert.ok(reason, 'expected a reason string');
  assert.match(reason, /2 spawn site\(s\)/);
  assert.match(reason, /line 3, 4/);
});

test('AC1 subset of the retired backlog gate: every shape it flagged is still flagged [0945d1b9 AC1]', () => {
  const retiredShapes = [
    L("import { DIST_INDEX } from './spawn-isolated-bin';", "spawn(process.execPath, [DIST_INDEX, 'list']);"),
    L(CP, "spawnSync(process.execPath, [DIST_INDEX, '--json'], { encoding: 'utf8' });"),
    L(CP, 'spawn(process.execPath, [DIST_INDEX]);'),
  ];
  for (const src of retiredShapes) {
    assert.match(src, NODE_SPAWN, 'fixture must be a shape the coarse retired regex matched');
    assert.equal(count(src), 1, `retired-gate shape no longer flagged: ${src}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Hardening negative controls (0945d1b9 AC1, AC2): each case below was accepted by the first guard and is now flagged,
// except the shorthand-HOME narrowing, which is the reverse (a bare HOME that is not an object property no longer routes).
// failure mode: the guard reports "routed" for a spawn that still hands the child the real HOME, so the leak ships green.
// tier: S (in-memory source strings through findUnroutedSpawnSites / collectSpawnIsolationViolations; nothing spawns)
// red: pending (user hold) - no run is recorded; against the first guard each "violation appears" case counts 0 sites.
// ---------------------------------------------------------------------------------------------------------------

const REAL_HOME_INITIALIZERS = {
  'os.homedir()': 'os.homedir()',
  'homedir()': 'homedir()',
  'process.env.HOME': 'process.env.HOME',
};

for (const [label, init] of Object.entries(REAL_HOME_INITIALIZERS)) {
  test(`AC1 control (violation appears): HOME bound to an identifier initialised from ${label} is unrouted [0945d1b9 AC1]`, () => {
    const src = L(
      CP,
      `const home = ${init};`,
      'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: home } });',
    );
    assert.equal(count(src), 1, `expected one unrouted site, got ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

test('AC1 control (violation appears): a `let` identifier initialised from the real home is unrouted [0945d1b9 AC1]', () => {
  const src = L(CP, 'let home = os.homedir();', 'spawnSync(process.execPath, [bin], { env: { HOME: home } });');
  assert.equal(count(src), 1);
});

test('AC1 control (violation appears): process.env.HOME assigned from an identifier holding the real home is unrouted [0945d1b9 AC1]', () => {
  const src = L(CP, 'const home = os.homedir();', 'process.env.HOME = home;', 'spawnSync(process.execPath, [bin]);');
  assert.equal(count(src), 1);
});

test('AC1 control: an identifier initialised from a throwaway directory still routes (the resolution does not over-flag) [0945d1b9 AC1]', () => {
  const src = L(
    CP,
    "const home = mkdtempSync(join(tmpdir(), 'h-'));",
    'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: home } });',
  );
  assert.equal(count(src), 0);
});

test('AC1 documented limit: an identifier with no resolvable initializer (a parameter) is treated as routed [0945d1b9 AC1]', () => {
  const src = L(CP, 'function run(home) {', '  spawnSync(process.execPath, [bin], { env: { HOME: home } });', '}');
  assert.equal(count(src), 0);
});

// ---- aliased and exec-family child_process bindings --------------------------------------------------------------

const ALIASED_SITES = {
  'import { spawn as launch }': L(
    "import { spawn as launch } from 'node:child_process';",
    'launch(process.execPath, [bin]);',
  ),
  'import { spawnSync as run } from the unprefixed module': L(
    "import { spawnSync as run } from 'child_process';",
    'run(process.execPath, [bin]);',
  ),
  'const { spawnSync: run } = require()': L(
    "const { spawnSync: run } = require('child_process');",
    'run(process.execPath, [bin]);',
  ),
  'const { fork: launch } = await import()': L(
    "const { fork: launch } = await import('node:child_process');",
    'launch(modulePath, []);',
  ),
  'namespace member cp.spawnSync': L(
    "import * as cp from 'node:child_process';",
    'cp.spawnSync(process.execPath, [bin]);',
  ),
};

for (const [form, src] of Object.entries(ALIASED_SITES)) {
  test(`AC1 control (violation appears): aliased child_process binding is a site: ${form} [0945d1b9 AC1]`, () => {
    assert.equal(count(src), 1, `expected one unrouted site, got ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

test('AC1 control: an aliased spawn routed with HOME is clean [0945d1b9 AC1]', () => {
  const src = L(
    "import { spawn as launch } from 'node:child_process';",
    'launch(process.execPath, [bin], { env: { ...process.env, HOME: tmp } });',
  );
  assert.equal(count(src), 0);
});

test('AC1 control: a local function that merely has an alias-like name and is not from child_process is not a site [0945d1b9 AC1]', () => {
  const src = L('const launch = (exe, args) => [exe, ...args];', 'launch(process.execPath, [bin]);');
  assert.equal(count(src), 0);
});

const EXEC_SITES = {
  'execSync of a node command template': L("import { execSync } from 'node:child_process';", 'execSync(`node ${bin} --json`);'),
  'exec of a node command string with a callback': L("import { exec } from 'node:child_process';", "exec('node dist/index.js list', cb);"),
  'execSync of a command containing process.execPath': L(
    "import { execSync } from 'node:child_process';",
    'execSync(`${process.execPath} ${bin}`);',
  ),
  'namespace cp.execSync of a node command': L("import * as cp from 'node:child_process';", "cp.execSync('node dist/index.js');"),
};

for (const [form, src] of Object.entries(EXEC_SITES)) {
  test(`AC1 control (violation appears): string-form exec of a node bin is a site: ${form} [0945d1b9 AC1]`, () => {
    assert.equal(count(src), 1, `expected one unrouted site, got ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

test('AC1 control: exec of a non-node command is not a site, and a routed exec of node is clean [0945d1b9 AC1]', () => {
  assert.equal(count(L("import { execSync } from 'node:child_process';", "execSync('git status');")), 0);
  assert.equal(
    count(L("import { execSync } from 'node:child_process';", "execSync('node x.js', { env: { ...process.env, HOME: tmp } });")),
    0,
  );
});

// ---- shorthand HOME only counts inside an object literal ---------------------------------------------------------

const NOT_OBJECT_SHORTHAND = {
  'HOME as a bare call argument': L(CP, 'spawnSync(process.execPath, [bin], buildEnv(tmp, HOME));'),
  'HOME as an argv element': L(CP, 'spawnSync(process.execPath, [bin, HOME]);'),
};

for (const [form, src] of Object.entries(NOT_OBJECT_SHORTHAND)) {
  test(`AC1 control (violation appears): ${form} is not HOME routing [0945d1b9 AC1]`, () => {
    assert.equal(count(src), 1, `expected one unrouted site, got ${JSON.stringify(findUnroutedSpawnSites(src))}`);
  });
}

test('AC1 control: shorthand HOME inside an object literal still routes, alone or among other keys [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, 'spawnSync(process.execPath, [bin], { env: { HOME } });')), 0);
  assert.equal(count(L(CP, 'spawnSync(process.execPath, [bin], { env: { a, HOME, b } });')), 0);
});

test('AC1 control (violation appears): shorthand { HOME } whose declaration is the real home is unrouted [0945d1b9 AC1]', () => {
  const src = L(CP, 'const HOME = os.homedir();', 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME } });');
  assert.equal(count(src), 1);
});

test('AC1 an aliased site reports the original child_process export name as callee [0945d1b9 AC1]', () => {
  const src = L("import { spawn as launch } from 'node:child_process';", 'launch(process.execPath, [bin]);');
  assert.equal(findUnroutedSpawnSites(src)[0].callee, 'spawn');
});

test('AC1 control: a saved copy of the real home (prevHome) bound as HOME is unrouted; stubEnv(HOME) routes [0945d1b9 AC1]', () => {
  assert.equal(count(L(CP, 'const prevHome = process.env.HOME;', 'spawnSync(process.execPath, [bin], { env: { HOME: prevHome } });')), 1);
  assert.equal(count(L(CP, "vi.stubEnv('HOME', tmp);", 'spawnSync(process.execPath, [bin]);')), 0);
});

// ---- baseline entries that are not positive-integer-count objects ----------------------------------------------------

const BAD_ENTRIES = [
  ['null', null],
  ['a bare string', 'two'],
  ['a bare number', 3],
  ['an object with a fractional count', { count: 1.5, reason: 'x' }],
];

for (const [label, bad] of BAD_ENTRIES) {
  test(`AC2 a baseline entry that is ${label} is spawn-isolation-baseline-invalid and does not throw [0945d1b9 AC2]`, () => {
    withFixture({ [SPEC]: ROUTED }, (root) => {
      const ghost = 'packages/envuser/src/gone.e2e.test.ts';
      let res;
      assert.doesNotThrow(() => {
        res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [ghost]: bad }) });
      });
      assert.ok(rulesOf(res).includes('spawn-isolation-baseline-invalid'), JSON.stringify(res.violations));
      assert.ok(res.violations.some((v) => v.rule === 'spawn-isolation-baseline-invalid' && v.detail.includes(ghost)));
    });
  });
}

// ---- deliberate looseness versus the retired backlog gate ------------------------------------------------------------

test('AC2 pinned looseness (partial): a DIST_INDEX spawn with no helper import is accepted when it sets HOME, though the retired gate flagged it [0945d1b9 AC2]', () => {
  // failure mode: a future tightening or loosening of the per-call HOME rule changes this silently.
  // The retired backlog gate flagged EVERY direct DIST_INDEX spawn that did not import an isolation helper, even one that
  // set HOME. The per-site guard deliberately accepts an explicit HOME override in the call, so AC2 (the retired gate's
  // coverage is a subset of the new guard's) holds only in part: the retired regex matches this shape, the guard does not.
  const src = L(CP, 'spawn(process.execPath, [DIST_INDEX], { env: { ...process.env, HOME: tmp } });');
  assert.match(src, NODE_SPAWN, 'fixture must be a shape the coarse retired regex matched');
  assert.equal(count(src), 0);
  // control: the same spawn without the HOME override is flagged, so the acceptance comes from the override alone.
  assert.equal(count(L(CP, 'spawn(process.execPath, [DIST_INDEX]);')), 1);
});

test('AC1 scanSource blanks comments in place and masks literals, preserving length and newlines [0945d1b9 AC1]', () => {
  const src = L("const a = 'x'; // note", '/* block', 'two */ const b = `t`;');
  const { code, mask } = scanSource(src);
  assert.equal(code.length, src.length);
  assert.equal(code.split('\n').length, src.split('\n').length);
  assert.ok(!code.includes('note'));
  assert.ok(!code.includes('block'));
  assert.equal(mask[src.indexOf("'x'") + 1], 1, 'string content is masked');
  assert.equal(mask[src.indexOf('`t`') + 1], 1, 'template content is masked');
  assert.equal(mask[src.indexOf('const a')], 0, 'code is not masked');
});

// ---------------------------------------------------------------------------------------------------------------
// normalizeBaseline
// ---------------------------------------------------------------------------------------------------------------

test('AC2 normalizeBaseline reads the per-file count shape [0945d1b9 AC2]', () => {
  const m = normalizeBaseline({ unrouted: { 'packages/a/x.spec.ts': { count: 2, reason: 'r' } } });
  assert.equal(m.get('packages/a/x.spec.ts').count, 2);
  assert.equal(m.get('packages/a/x.spec.ts').reason, 'r');
});

test('AC2 normalizeBaseline tolerates the legacy array (no count ceiling) and empty input [0945d1b9 AC2]', () => {
  const legacy = normalizeBaseline({ unrouted: ['packages/a/x.spec.ts'] });
  assert.equal(legacy.get('packages/a/x.spec.ts').count, Number.POSITIVE_INFINITY);
  assert.equal(normalizeBaseline(undefined).size, 0);
  assert.equal(normalizeBaseline({}).size, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// AC2 - ratchet over a fixture workspace
// ---------------------------------------------------------------------------------------------------------------

const ENV_PKG = JSON.stringify({ name: '@adhd/envuser', version: '0.0.0', dependencies: { '@adhd/environment-core-node': '*' } });
const PLAIN_PKG = JSON.stringify({ name: '@adhd/plain', version: '0.0.0' });
const SPEC = 'packages/envuser/src/a.e2e.test.ts';
const ONE_UNROUTED = L(CP, '', 'spawnSync(process.execPath, [bin]);', ''); //      site on line 3
const TWO_UNROUTED = L(CP, '', 'spawnSync(process.execPath, [bin]);', 'spawn(process.execPath, [bin]);', ''); // lines 3 and 4
const ROUTED = L(CP, '', 'spawnSync(process.execPath, [bin], { env: { ...process.env, HOME: tmp } });', '');

/** Build a fixture workspace under tmp/ and return its absolute root. */
function fixture(files) {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'ws-'));
  for (const [rel, content] of Object.entries({ 'packages/envuser/package.json': ENV_PKG, ...files })) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}
const close = (root) => rmSync(root, { recursive: true, force: true });
const rulesOf = (res) => res.violations.map((v) => v.rule);
const baselineOf = (entries) => ({ unrouted: entries });

function withFixture(files, fn) {
  const root = fixture(files);
  try {
    return fn(root);
  } finally {
    close(root);
  }
}

test('AC2 a file with an unrouted spawn and no baseline entry fails, naming file:line [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ONE_UNROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-unrouted']);
    assert.ok(res.violations[0].detail.includes(`${SPEC}:3 (spawnSync)`), res.violations[0].detail);
    assert.equal(res.scanned, 1);
  });
});

test('AC2 control: the routed equivalent of that file is clean and still counted as scanned [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
    assert.deepEqual(res.violations, []);
    assert.equal(res.scanned, 1);
  });
});

test('AC2 control: the same unrouted file in a package with no @adhd/environment dependency is out of scope [0945d1b9 AC2]', () => {
  withFixture(
    { 'packages/plain/package.json': PLAIN_PKG, 'packages/plain/src/a.e2e.test.ts': ONE_UNROUTED, [SPEC]: ROUTED },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
      assert.deepEqual(res.violations, []);
      assert.equal(res.scanned, 1, 'only the env-family spec is scanned');
    },
  );
});

test('AC2 the owning package is the NEAREST package.json, so a nested non-env package opts its files out [0945d1b9 AC2]', () => {
  withFixture(
    { 'packages/envuser/sub/package.json': PLAIN_PKG, 'packages/envuser/sub/b.spec.ts': ONE_UNROUTED, [SPEC]: ROUTED },
    (root) => {
      assert.deepEqual(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) }).violations, []);
    },
  );
});

test('AC2 only spec, test and e2e files are scanned, not helpers or fixtures [0945d1b9 AC2]', () => {
  withFixture({ 'packages/envuser/src/helper.ts': ONE_UNROUTED, [SPEC]: ROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
    assert.deepEqual(res.violations, []);
    assert.equal(res.scanned, 1);
  });
});

for (const ext of ['spec', 'test', 'e2e']) {
  test(`AC2 a *.${ext}.ts file is scanned [0945d1b9 AC2]`, () => {
    withFixture({ [`packages/envuser/src/x.${ext}.ts`]: ONE_UNROUTED }, (root) => {
      assert.deepEqual(rulesOf(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) })), ['spawn-isolation-unrouted']);
    });
  });
}

test('AC2 node_modules and dist trees are never scanned [0945d1b9 AC2]', () => {
  withFixture(
    {
      'packages/envuser/node_modules/dep/a.spec.ts': ONE_UNROUTED,
      'packages/envuser/dist/a.spec.js': ONE_UNROUTED,
      [SPEC]: ROUTED,
    },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
      assert.deepEqual(res.violations, []);
      assert.equal(res.scanned, 1);
    },
  );
});

test('AC2 entrypoint/ is scanned like packages/ [0945d1b9 AC2]', () => {
  withFixture(
    { 'entrypoint/tool/package.json': ENV_PKG, 'entrypoint/tool/src/a.e2e.test.ts': ONE_UNROUTED },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
      assert.ok(res.violations.some((v) => v.rule === 'spawn-isolation-unrouted' && v.detail.includes('entrypoint/tool/src/a.e2e.test.ts:3')));
    },
  );
});

test('AC2 a baselined file at exactly its recorded count is tolerated [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ONE_UNROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [SPEC]: { count: 1, reason: 'legacy' } }) });
    assert.deepEqual(res.violations, []);
  });
});

test('AC2 ratchet: a count ABOVE the baseline fails, naming file:line of every site and the allowance [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: TWO_UNROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [SPEC]: { count: 1, reason: 'legacy' } }) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-unrouted']);
    const d = res.violations[0].detail;
    assert.ok(d.includes(`${SPEC}:3`), d);
    assert.ok(d.includes(`${SPEC}:4`), d);
    assert.match(d, /baseline allows 1/);
  });
});

test('AC2 ratchet: a count BELOW the baseline fails as spawn-isolation-baseline-stale and says what to lower it to [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ONE_UNROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [SPEC]: { count: 3, reason: 'legacy' } }) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-baseline-stale']);
    assert.match(res.violations[0].detail, /lower the count to 1/);
  });
});

test('AC2 stale: an entry whose file is now fully routed asks for the entry to be removed [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [SPEC]: { count: 1, reason: 'legacy' } }) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-baseline-stale']);
    assert.match(res.violations[0].detail, /remove the entry/);
  });
});

test('AC2 stale: an entry for a deleted or renamed file fails until removed [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ROUTED }, (root) => {
    const ghost = 'packages/envuser/src/gone.e2e.test.ts';
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [ghost]: { count: 1, reason: 'legacy' } }) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-baseline-stale']);
    assert.ok(res.violations[0].detail.includes(ghost));
  });
});

test('AC2 control: an entry under a root the run does not scan is not reported stale [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, {
      baseline: baselineOf({ [SPEC]: { count: 1, reason: 'legacy' } }),
      roots: ['entrypoint'],
    });
    assert.deepEqual(res.violations, []);
  });
});

for (const [label, bad] of [['zero', 0], ['negative', -1], ['fractional', 1.5], ['non-numeric', 'two'], ['missing', undefined]]) {
  test(`AC2 a ${label} count is spawn-isolation-baseline-invalid [0945d1b9 AC2]`, () => {
    withFixture({ [SPEC]: ROUTED }, (root) => {
      const ghost = 'packages/envuser/src/gone.e2e.test.ts';
      const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [ghost]: { count: bad, reason: 'x' } }) });
      assert.deepEqual(rulesOf(res), ['spawn-isolation-baseline-invalid']);
      assert.ok(res.violations[0].detail.includes(ghost));
    });
  });
}

test('AC2 control: a positive integer count is not invalid [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ONE_UNROUTED }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({ [SPEC]: { count: 1, reason: 'x' } }) });
    assert.ok(!rulesOf(res).includes('spawn-isolation-baseline-invalid'));
  });
});

test('AC2 the legacy array baseline tolerates a file while it still has a site and goes stale once routed [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: TWO_UNROUTED }, (root) => {
    assert.deepEqual(collectSpawnIsolationViolations(root, { baseline: { unrouted: [SPEC] } }).violations, []);
  });
  withFixture({ [SPEC]: ROUTED }, (root) => {
    assert.deepEqual(rulesOf(collectSpawnIsolationViolations(root, { baseline: { unrouted: [SPEC] } })), ['spawn-isolation-baseline-stale']);
  });
});

test('AC2 helpers option: with no helpers a helper-routed file is flagged [0945d1b9 AC2]', () => {
  const helperRouted = L(
    CP,
    "import { isolatedSpawnOptions } from './spawn-isolated-bin';",
    'spawnSync(process.execPath, [bin], isolatedSpawnOptions());',
  );
  withFixture({ [SPEC]: helperRouted }, (root) => {
    assert.deepEqual(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) }).violations, []);
    assert.deepEqual(rulesOf(collectSpawnIsolationViolations(root, { baseline: baselineOf({}), helpers: [] })), ['spawn-isolation-unrouted']);
  });
});

test('AC2 zero-scan guard: env-family packages exist but no spec/e2e file was scanned [0945d1b9 AC2]', () => {
  withFixture({ 'packages/envuser/src/index.ts': 'export {};\n' }, (root) => {
    const res = collectSpawnIsolationViolations(root, { baseline: baselineOf({}) });
    assert.deepEqual(rulesOf(res), ['spawn-isolation-scan-found-nothing']);
    assert.equal(res.scanned, 0);
  });
});

test('AC2 zero-scan control: scanning at least one file silences the guard; no env package at all is also silent [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ROUTED }, (root) => {
    assert.ok(!rulesOf(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) })).includes('spawn-isolation-scan-found-nothing'));
  });
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'ws-'));
  try {
    mkdirSync(join(root, 'packages/plain'), { recursive: true });
    writeFileSync(join(root, 'packages/plain/package.json'), PLAIN_PKG);
    assert.deepEqual(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) }).violations, []);
  } finally {
    close(root);
  }
});

test('AC2 the baseline is read from BASELINE_REL under the scanned workspace root; a missing file is an empty baseline [0945d1b9 AC2]', () => {
  withFixture({ [SPEC]: ONE_UNROUTED }, (root) => {
    assert.deepEqual(rulesOf(collectSpawnIsolationViolations(root)), ['spawn-isolation-unrouted']);
  });
  withFixture(
    { [SPEC]: ONE_UNROUTED, [BASELINE_REL]: JSON.stringify(baselineOf({ [SPEC]: { count: 1, reason: 'on disk' } })) },
    (root) => {
      assert.deepEqual(collectSpawnIsolationViolations(root).violations, []);
    },
  );
});

test('AC2 an explicit baseline option overrides the on-disk file [0945d1b9 AC2]', () => {
  withFixture(
    { [SPEC]: ONE_UNROUTED, [BASELINE_REL]: JSON.stringify(baselineOf({ [SPEC]: { count: 1, reason: 'on disk' } })) },
    (root) => {
      assert.deepEqual(rulesOf(collectSpawnIsolationViolations(root, { baseline: baselineOf({}) })), ['spawn-isolation-unrouted']);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Rule 9 in runChecks honours the --workspace-root fixture contract [0945d1b9 AC2]
// ---------------------------------------------------------------------------------------------------------------

const GATE_TARGETS = ['test', 'e2e'];
const NO_PUBLISH = () => [];

function ruleNineFiles(specSource) {
  const fooProject = {
    name: 'foo',
    targets: {
      test: { executor: 'nx:run-commands' },
      e2e: { executor: 'nx:run-commands', cache: true, inputs: ['default'] },
    },
  };
  return {
    'packages/foo/project.json': JSON.stringify(fooProject, null, 2),
    'packages/foo/package.json': ENV_PKG.replace('@adhd/envuser', '@adhd/foo'),
    'packages/foo/src/a.e2e.ts': '',
    'packages/foo/src/b.e2e.test.ts': specSource,
    'packages/foo/vite.config.ts': 'export default {\n  plugins: [nxViteTsPaths()],\n};\n',
    '.githooks/pre-push': 'flags=$(node "$repo_root/.githooks/lib/pre-push-flags.mjs")\n',
    '.github/workflows/pull-request.yml': 'npx nx affected -t test --parallel=5\nnpx nx affected -t e2e --parallel=1\n',
    '.github/workflows/ci.yml': 'npx nx affected -t test build\nnpx nx affected -t e2e --parallel=1\n',
  };
}

async function ruleNine(files, extra = {}) {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'r9-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const res = await runChecks({
      workspaceRoot: root,
      gateTargets: GATE_TARGETS,
      createNodesFn: NO_PUBLISH,
      baseline: { tsconfigSpecWithoutCompileTarget: [] },
      agentLaneBaseline: { pendingMove: [] },
      ...extra,
    });
    return res.violations.filter((v) => v.rule.startsWith('9-'));
  } finally {
    close(root);
  }
}

test('rule 9 RED: an unrouted node spawn in an env-family spec fires 9-spawn-isolation-unrouted with file:line [0945d1b9 AC1]', async () => {
  const v = await ruleNine(ruleNineFiles(ONE_UNROUTED));
  assert.deepEqual(
    v.map((x) => x.rule),
    ['9-spawn-isolation-unrouted'],
  );
  assert.ok(v[0].detail.includes('packages/foo/src/b.e2e.test.ts:3'), v[0].detail);
});

test('rule 9 fixture contract: a fixture workspace with no baseline file passes when every spawn is routed [0945d1b9 AC2]', async () => {
  assert.deepEqual(await ruleNine(ruleNineFiles(ROUTED)), []);
});

test('rule 9 fixture contract: the repository baseline is not consulted for a fixture workspace [0945d1b9 AC2]', async () => {
  // The repo baseline lists real files that do not exist in the fixture; were it read, each would surface as stale.
  const v = await ruleNine(ruleNineFiles(ROUTED));
  assert.ok(!v.some((x) => x.rule === '9-spawn-isolation-baseline-stale'), JSON.stringify(v));
});

test('rule 9: the spawnIsolationBaseline override tolerates a recorded site [0945d1b9 AC2]', async () => {
  const v = await ruleNine(ruleNineFiles(ONE_UNROUTED), {
    spawnIsolationBaseline: baselineOf({ 'packages/foo/src/b.e2e.test.ts': { count: 1, reason: 'legacy' } }),
  });
  assert.deepEqual(v, []);
});

test('rule 9: the spawnIsolationBaseline override is enforced as a ratchet (stale count fails) [0945d1b9 AC2]', async () => {
  const v = await ruleNine(ruleNineFiles(ONE_UNROUTED), {
    spawnIsolationBaseline: baselineOf({ 'packages/foo/src/b.e2e.test.ts': { count: 2, reason: 'legacy' } }),
  });
  assert.deepEqual(
    v.map((x) => x.rule),
    ['9-spawn-isolation-baseline-stale'],
  );
});

test('rule 9: the on-disk baseline of the fixture workspace is honoured when no override is passed [0945d1b9 AC2]', async () => {
  const files = ruleNineFiles(ONE_UNROUTED);
  files[BASELINE_REL] = JSON.stringify(baselineOf({ 'packages/foo/src/b.e2e.test.ts': { count: 1, reason: 'legacy' } }));
  assert.deepEqual(await ruleNine(files), []);
});
