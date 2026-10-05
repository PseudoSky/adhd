/**
 * star-externals.spec.mjs — the audit that keeps the 2.1.0 broken-publish shape
 * (uid 82648d73) from recurring: no publishable manifest may declare a `"*"`
 * version for ANY dependency (a `*` is what let a clean install resolve zod
 * 3.25.76 against a monorepo on 4.4.3 → `z.toJSONSchema is not a function`).
 *
 * Two layers:
 *   - a pure detector with fixture teeth (proves the detector is not vacuous), and
 *   - the real assertion over THIS workspace's manifests — the DONE-STATE gate.
 *
 * Run: `node --test tools/nx-plugins/build/lib/star-externals.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const workspaceRoot = findRoot(here);

/** Every version-bearing dependency field a `*` could hide in. devDependencies are
 *  included because a `*` there is still an unpinned, unreproducible install. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'tmp', '.adhd', '.git', '.nx']);

/** Walk `packages/` + `entrypoint/` for every package.json (skipping build/scratch dirs). */
export function findManifests(root = workspaceRoot) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const p = join(abs, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name === 'package.json') out.push(p);
    }
  };
  for (const base of ['packages', 'entrypoint']) {
    const b = join(root, base);
    if (existsSync(b)) walk(b);
  }
  return out;
}

/**
 * Pure: every `<manifest> <field> <dep>` whose declared range is exactly `*` (or blank).
 * @param {string[]} manifests absolute paths
 * @param {(p: string) => any} [readImpl] injectable for tests
 */
export function findWildcardExternals(manifests, readImpl = (p) => JSON.parse(readFileSync(p, 'utf8'))) {
  const hits = [];
  for (const manifest of manifests) {
    let pkg;
    try { pkg = readImpl(manifest); } catch { continue; }
    for (const field of DEP_FIELDS) {
      const coll = pkg[field];
      if (!coll || typeof coll !== 'object') continue;
      for (const [dep, range] of Object.entries(coll)) {
        if (typeof range === 'string' && range.trim() === '*') {
          hits.push({ manifest, field, dep });
        }
      }
    }
  }
  return hits;
}

test('RED fixture: a `*` dependency is detected (the detector is not vacuous)', () => {
  const hits = findWildcardExternals(['/x/package.json'], () => ({
    name: '@adhd/x',
    dependencies: { zod: '*' },
    devDependencies: { '@nx/devkit': '*' },
    peerDependencies: { react: '^18.0.0' },
  }));
  assert.deepEqual(
    hits.map((h) => `${h.dep}:${h.field}`).sort(),
    ['@nx/devkit:devDependencies', 'zod:dependencies']
  );
});

test('GREEN fixture: real ranges (caret/tilde/exact/empty are NOT flagged, wildcard is)', () => {
  const hits = findWildcardExternals(['/x/package.json'], () => ({
    dependencies: { a: '^1.2.3', b: '~1.2.3', c: '1.2.3' },
    peerDependencies: { d: '*' },
  }));
  assert.deepEqual(hits.map((h) => h.dep), ['d']);
});

test('AUDIT — no publishable manifest in this workspace declares a `*` external (uid 82648d73)', () => {
  const manifests = findManifests(workspaceRoot);
  assert.ok(manifests.length > 0, 'expected to find workspace manifests to audit');
  const hits = findWildcardExternals(manifests);
  assert.deepEqual(
    hits.map((h) => `${h.dep} @ ${h.field} in ${h.manifest.replace(workspaceRoot + '/', '')}`),
    [],
    'A `"*"` dependency range resolves to whatever the registry has at install time — pin it to the monorepo-resolved range (see backlog uid 82648d73).'
  );
});
