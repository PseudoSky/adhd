/**
 * guards: a package ships with an internal dependency range that no published version satisfies, now that the publish-to-dependency-publish graph edge is gone
 * tier: S
 * cites: BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { unpublishedInternalDeps, formatUnpublished } = createRequire(import.meta.url)('./internal-deps-published.js');

const state = { '@adhd/a': { version: '1.2.0' } };

test('a range the published version satisfies passes', () => {
  assert.deepEqual(unpublishedInternalDeps({ dependencies: { '@adhd/a': '^1.2.0' } }, state), []);
});

test('a range ahead of the published version is reported with what the registry has', () => {
  assert.deepEqual(unpublishedInternalDeps({ dependencies: { '@adhd/a': '^1.3.0' } }, state), [
    { field: 'dependencies', dep: '@adhd/a', range: '^1.3.0', published: '1.2.0' },
  ]);
});

test('a dependency with no recorded version is reported', () => {
  assert.deepEqual(unpublishedInternalDeps({ dependencies: { '@adhd/ghost': '^1.0.0' } }, state), [
    { field: 'dependencies', dep: '@adhd/ghost', range: '^1.0.0', published: null },
  ]);
});

test('peer and optional internal ranges are checked too', () => {
  const m = unpublishedInternalDeps({ peerDependencies: { '@adhd/a': '^2.0.0' }, optionalDependencies: { '@adhd/a': '^3.0.0' } }, state);
  assert.deepEqual(m.map((x) => x.field).sort(), ['optionalDependencies', 'peerDependencies']);
});

test('third-party ranges, wildcards and workspace ranges are ignored', () => {
  assert.deepEqual(
    unpublishedInternalDeps({ dependencies: { lodash: '^9.0.0', '@adhd/a': '*', '@adhd/b': 'workspace:*' } }, state),
    []
  );
});

test('devDependencies are not published and are not checked', () => {
  assert.deepEqual(unpublishedInternalDeps({ devDependencies: { '@adhd/a': '^9.0.0' } }, state), []);
});

test('the message names the package, each range and the fix', () => {
  const msg = formatUnpublished('@adhd/b', '1.0.0', unpublishedInternalDeps({ dependencies: { '@adhd/a': '^1.3.0' } }, state));
  assert.match(msg, /refusing @adhd\/b@1\.0\.0/);
  assert.match(msg, /dependencies\.@adhd\/a \^1\.3\.0 — registry has 1\.2\.0/);
  assert.match(msg, /Publish the dependency first/);
});
