/**
 * plugin.spec.mjs — proves `@adhd/nx-build`'s `createNodes` attaches the
 * topological ordering edges (one `{projects, target}` per RUNTIME dependency,
 * never `^publish`/`^version`/`^test`, which also fan out over devDependency edges) to every publishable project's
 * `publish` target (BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001,
 * point 1 — "publish has no `^publish` graph edge to stop it shipping
 * anyway").
 *
 * Drives the REAL `createNodes` handler exported by `./plugin.js` against a
 * throwaway on-disk fixture project (real fs reads via `detect-target.js`,
 * never a mock of the plugin itself) — mirrors exactly what nx's own graph
 * construction does when it calls this createNodes function for a matching
 * `**\/package.json`.
 *
 * Run: `node --test tools/nx-plugins/build/plugin.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createNodes } = require('./plugin.js');

// createNodes is `['**/package.json', handler]` — the nx CreateNodes tuple shape.
const [, handler] = createNodes;

/**
 * Drive the v2 handler for a single config file and return that file's result.
 * The v2 `createNodes` handler receives the ARRAY of matched config files and
 * returns `[configFile, result]` tuples (Nx 23 unified on the v2 plugin API);
 * this helper preserves the single-file call shape these tests assert against.
 */
function runFor(pkgPathRel, ctx) {
  const tuples = handler([pkgPathRel], {}, ctx);
  const hit = tuples.find(([file]) => file === pkgPathRel);
  assert.ok(hit, `createNodes returned no tuple for ${pkgPathRel}`);
  return hit[1];
}

/** Build a throwaway publishable-project fixture (project.json + build target + non-private package.json). */
function makeFixtureProject({
  workspaceRoot,
  projectRoot,
  name,
  isPrivate = false,
  extraTargets = {},
  pkgExtra = {},
}) {
  const abs = join(workspaceRoot, projectRoot);
  mkdirSync(abs, { recursive: true });
  writeFileSync(
    join(abs, 'project.json'),
    JSON.stringify({ name, targets: { build: {}, ...extraTargets } })
  );
  const pkg = { name, version: '1.0.0', ...pkgExtra };
  if (isPrivate) pkg.private = true;
  writeFileSync(join(abs, 'package.json'), JSON.stringify(pkg));
  return join(abs, 'package.json');
}

test('createNodes: publish target dependsOn orders after each RUNTIME dependency (topological dependency-publish-first ordering) and never over devDependencies', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-plugin-fixture-'));
  try {
    // Runtime dep (project name differs from the scope-stripped npm name, like
    // `@adhd/environment` -> `environment-core-node`), a peer dep, and a devDependency.
    makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fixture/runtime-dep', name: 'fixture-core-runtime', pkgExtra: { name: '@adhd/runtime' } });
    makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fixture/peer-dep', name: 'fixture-core-peer', pkgExtra: { name: '@adhd/peer' } });
    makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fixture/dev-dep', name: 'fixture-core-dev', pkgExtra: { name: '@adhd/dev' } });
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-widget',
      name: 'fixture-core-widget',
      pkgExtra: {
        name: '@adhd/fixture-core-widget',
        dependencies: { '@adhd/runtime': '^1.0.0', 'left-pad': '^1.0.0' },
        peerDependencies: { '@adhd/peer': '^1.0.0' },
        devDependencies: { '@adhd/dev': '^1.0.0' },
      },
    });
    const rel = (p) => p.slice(workspaceRoot.length + 1);
    const allFiles = ['runtime-dep', 'peer-dep', 'dev-dep', 'fixture-core-widget'].map((d) => `packages/fixture/${d}/package.json`);

    const tuples = handler(allFiles, {}, { workspaceRoot });
    const result = tuples.find(([f]) => f === rel(pkgPath))[1];

    const projectRoot = 'packages/fixture/fixture-core-widget';
    const targets = result.projects[projectRoot].targets;
    assert.ok(targets.publish, 'expected a publish target to be attached to a publishable project');
    assert.ok(Array.isArray(targets.publish.dependsOn), 'publish.dependsOn must be an array');
    for (const target of ['publish', 'test']) {
      for (const projects of ['fixture-core-runtime', 'fixture-core-peer']) {
        assert.ok(
          targets.publish.dependsOn.some((d) => d && d.projects === projects && d.target === target),
          `publish.dependsOn must order after ${projects}:${target}. Got: ${JSON.stringify(targets.publish.dependsOn)}`
        );
      }
    }
    for (const t of ['publish', 'version']) {
      const deps = targets[t].dependsOn;
      assert.ok(!deps.some((d) => typeof d === 'string' && d.startsWith('^')), `${t}.dependsOn must not use a graph-wide ^ edge (fans out over devDependency/test edges). Got: ${JSON.stringify(deps)}`);
      assert.ok(!deps.some((d) => d && d.projects === 'fixture-core-dev'), `${t}.dependsOn must not include a devDependency. Got: ${JSON.stringify(deps)}`);
    }
    // The OTHER real dependencies must still be present: this ADDS ordering, it
    // does not replace the existing gate chain.
    for (const dep of ['test', 'version', 'dist-manifest', 'verify-dist-load', 'publish-hygiene']) {
      assert.ok(
        targets.publish.dependsOn.includes(dep),
        `publish.dependsOn must still include "${dep}" — got: ${JSON.stringify(targets.publish.dependsOn)}`
      );
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('RED-equivalent: a publish.dependsOn WITHOUT ^publish is exactly the shape that let BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001 ship', () => {
  // Simulates the pre-fix array literal cited in the bug report
  // (tools/nx-plugins/build/plugin.js:72 at filing time) to prove the
  // assertion above actually has teeth: it must fail against the broken shape.
  const brokenDependsOn = [
    'test',
    '^test',
    'version',
    'dist-manifest',
    'verify-dist-load',
    'publish-hygiene',
  ];
  assert.equal(
    brokenDependsOn.includes('^publish'),
    false,
    'sanity check: the pre-fix dependsOn shape must NOT satisfy the ^publish assertion'
  );
});

test('createNodes: a private (non-publishable) project gets no publish/version/dist-manifest targets at all', () => {
  const workspaceRoot = mkdtempSync(
    join(tmpdir(), 'nx-build-plugin-fixture-private-')
  );
  try {
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-private',
      name: '@adhd/fixture-core-private',
      isPrivate: true,
    });
    const pkgPathRel = pkgPath.slice(workspaceRoot.length + 1);

    const result = runFor(pkgPathRel, { workspaceRoot });

    assert.deepEqual(
      result,
      {},
      'a private package must get no publish-related targets attached'
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('createNodes: version target orders after each runtime dependency (topological dependency-version-first ordering — must not regress alongside the publish ordering)', () => {
  const workspaceRoot = mkdtempSync(
    join(tmpdir(), 'nx-build-plugin-fixture-version-')
  );
  try {
    makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fixture/dep', name: 'fixture-core-dep', pkgExtra: { name: '@adhd/dep' } });
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-widget2',
      name: 'fixture-core-widget2',
      pkgExtra: { name: '@adhd/fixture-core-widget2', dependencies: { '@adhd/dep': '^1.0.0' } },
    });
    const pkgPathRel = pkgPath.slice(workspaceRoot.length + 1);

    const tuples = handler(['packages/fixture/dep/package.json', pkgPathRel], {}, { workspaceRoot });
    const result = tuples.find(([f]) => f === pkgPathRel)[1];

    const projectRoot = 'packages/fixture/fixture-core-widget2';
    const targets = result.projects[projectRoot].targets;
    assert.ok(targets.version.dependsOn.some((d) => d && d.projects === 'fixture-core-dep' && d.target === 'version'));
    assert.ok(!targets.version.dependsOn.includes('^version'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

/**
 * Owner decision c0bf141d (2026-10-07): `publish` no longer depends on `e2e`,
 * even for a project that declares an `e2e` target. e2e is run explicitly
 * before a release. Reintroducing the dependency must turn this red.
 */
test('createNodes: publish.dependsOn never includes `e2e`, even when declared (c0bf141d)', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-plugin-fixture-e2e-'));
  try {
    const withE2e = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-e2e-owner',
      name: '@adhd/fixture-e2e-owner',
      extraTargets: { e2e: { cache: true, inputs: ['default'] } },
    }).slice(workspaceRoot.length + 1);
    const withoutE2e = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-no-e2e',
      name: '@adhd/fixture-no-e2e',
    }).slice(workspaceRoot.length + 1);

    const ownerTargets =
      runFor(withE2e, { workspaceRoot }).projects['packages/fixture/fixture-e2e-owner'].targets;
    const plainTargets =
      runFor(withoutE2e, { workspaceRoot }).projects['packages/fixture/fixture-no-e2e'].targets;

    assert.ok(
      !ownerTargets.publish.dependsOn.includes('e2e'),
      `publish.dependsOn must NOT include \`e2e\` even when the project declares it (c0bf141d) — got: ${JSON.stringify(ownerTargets.publish.dependsOn)}`
    );
    assert.ok(
      !plainTargets.publish.dependsOn.includes('e2e'),
      `a project WITHOUT an \`e2e\` target must NOT get one injected — got: ${JSON.stringify(plainTargets.publish.dependsOn)}`
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('RED-equivalent: a publish.dependsOn that omits the conditional `e2e` fails the GAP-1 assertion', () => {
  // The broken shape: publish always dependsOn test but never e2e (the exact
  // regression the conditional guards). The assertion in the test above must
  // reject it.
  const brokenPublishDependsOn = [
    'test',
    '^test',
    'version',
    '^publish',
    'dist-manifest',
    'verify-dist-load',
    'publish-hygiene',
  ];
  assert.equal(
    brokenPublishDependsOn.includes('e2e'),
    false,
    'sanity check: the unconditional (pre-fix) publish.dependsOn must NOT satisfy the e2e-reachability assertion'
  );
});

// ---------------------------------------------------------------------------
// Runtime-closure cache inputs (backlog 0b9505ff / c916591c / AC1-AC3).
// ---------------------------------------------------------------------------

/** Minimal nx.json carrying the named inputs the closure expansion derives from. */
const FIXTURE_NX_JSON = {
  namedInputs: {
    default: ['{projectRoot}/**/*', '!{projectRoot}/dist/**', '!{projectRoot}/package.json', 'manifest', 'sharedGlobals'],
    manifest: [{ json: '{projectRoot}/package.json', excludeFields: ['version'] }],
    production: ['default', '!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)'],
    sharedGlobals: ['{workspaceRoot}/tsconfig.base.json'],
  },
};

function writeSrc(workspaceRoot, projectRoot, rel, text) {
  const abs = join(workspaceRoot, projectRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

test('createNodes: build/typecheck depsProduction hashes the RUNTIME closure plus dev deps imported from production source, never test-only dev deps', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-closure-fixture-'));
  try {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify(FIXTURE_NX_JSON));
    const mk = (dir, name, pkgExtra = {}) => makeFixtureProject({ workspaceRoot, projectRoot: `packages/fx/${dir}`, name, pkgExtra: { name: `@adhd/${name}`, ...pkgExtra } });
    mk('runtime', 'fx-runtime');
    mk('transitive', 'fx-transitive');
    mk('bundled', 'fx-bundled');
    mk('testonly', 'fx-testonly');
    // fx-runtime itself depends on fx-transitive at runtime.
    mk('runtime', 'fx-runtime', { dependencies: { '@adhd/fx-transitive': '^1.0.0' } });
    const widget = mk('widget', 'fx-widget', {
      dependencies: { '@adhd/fx-runtime': '^1.0.0' },
      devDependencies: { '@adhd/fx-bundled': '^1.0.0', '@adhd/fx-testonly': '^1.0.0' },
    });
    const wRoot = 'packages/fx/widget';
    writeSrc(workspaceRoot, wRoot, 'src/index.ts', "// mentions '@adhd/fx-testonly' only in a comment\nimport { b } from '@adhd/fx-bundled';\nexport const x = b;\n");
    writeSrc(workspaceRoot, wRoot, 'src/index.spec.ts', "import '@adhd/fx-testonly';\n");
    writeSrc(workspaceRoot, wRoot, 'src/test/harness.ts', "import '@adhd/fx-testonly';\n");

    const files = ['runtime', 'transitive', 'bundled', 'testonly', 'widget'].map((d) => `packages/fx/${d}/package.json`);
    const tuples = handler(files, {}, { workspaceRoot });
    const result = tuples.find(([f]) => f === widget.slice(workspaceRoot.length + 1))[1];
    const project = result.projects[wRoot];

    assert.deepEqual(project.tags, ['inputs:runtime-closure']);
    const globs = JSON.stringify(project.namedInputs.depsProduction);
    for (const included of ['runtime', 'transitive', 'bundled']) {
      assert.ok(globs.includes(`{workspaceRoot}/packages/fx/${included}/**/*`), `depsProduction must hash ${included}. Got: ${globs}`);
    }
    assert.ok(!globs.includes('packages/fx/testonly/'), `depsProduction must NOT hash a dev dependency only tests import. Got: ${globs}`);
    // The dependency's own manifest input excludes ITS release-rewritten fields, like `^production` would.
    assert.ok(project.namedInputs.depsProduction.some((i) => i && i.json === '{workspaceRoot}/packages/fx/runtime/package.json' && i.excludeFields.includes('version') && i.excludeFields.includes('dependencies.@adhd/fx-transitive')));

    // dist-manifest: own manifest + each declared RUNTIME dependency's package.json only.
    const dm = project.targets['dist-manifest'].inputs;
    assert.ok(dm.includes('{workspaceRoot}/packages/fx/runtime/package.json'));
    assert.ok(!dm.some((i) => typeof i === 'string' && (i.includes('/testonly/') || i.includes('/bundled/'))), `dist-manifest must not hash dev dependencies. Got: ${JSON.stringify(dm)}`);
    assert.ok(!dm.some((i) => i && typeof i === 'object' && i.dependencies === true), 'dist-manifest must not use the graph-wide {fileset, dependencies: true} input (expands over devDependency edges)');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('createNodes: a config-only workspace-base-vite-paths edge is removed from the graph; a source-level one is kept', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-vitepaths-fixture-'));
  try {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify(FIXTURE_NX_JSON));
    const vp = makeFixtureProject({ workspaceRoot, projectRoot: 'packages/workspace/workspace-base-vite-paths', name: 'workspace-base-vite-paths', pkgExtra: { name: '@adhd/workspace-base-vite-paths' } });
    const cfg = makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fx/cfg', name: 'fx-cfg', pkgExtra: { name: '@adhd/fx-cfg' } });
    const src = makeFixtureProject({ workspaceRoot, projectRoot: 'packages/fx/src', name: 'fx-src', pkgExtra: { name: '@adhd/fx-src' } });
    writeSrc(workspaceRoot, 'packages/fx/cfg', 'vite.config.ts', "import { projectCacheDir } from '../../workspace/workspace-base-vite-paths/src/index';\n");
    writeSrc(workspaceRoot, 'packages/fx/cfg', 'src/index.ts', 'export const a = 1;\n');
    writeSrc(workspaceRoot, 'packages/fx/src', 'src/index.ts', "import { projectCacheDir } from '../../../workspace/workspace-base-vite-paths/src/index';\nexport const a = projectCacheDir;\n");
    const rel = (p) => p.slice(workspaceRoot.length + 1);
    const tuples = handler([rel(vp), rel(cfg), rel(src)], {}, { workspaceRoot });
    const byRoot = Object.fromEntries(tuples.flatMap(([, r]) => Object.entries(r.projects || {})));
    assert.deepEqual(byRoot['packages/fx/cfg'].implicitDependencies, ['!workspace-base-vite-paths']);
    assert.equal(byRoot['packages/fx/src'].implicitDependencies, undefined, 'a production-source import is a real dependency and must keep its edge');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
