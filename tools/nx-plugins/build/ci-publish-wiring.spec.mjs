/**
 * Structural (grep-based) teeth tests for the CI Publish wiring — proving that
 * `.github/workflows/pull-request.yml`'s `Publish` step publishes through
 * `run-release.mjs --publish-only`, never a bare `nx affected -t version` /
 * `-t publish` or a bare `nx run-many -t version/publish`.
 *
 * ROOT CAUSES this guards:
 *   1. A bare `nx affected -t version/publish` can never publish: the `publish` executor's
 *      `checkPublishAllowed` refuses any project not listed in a fresh `.adhd/tmp/release-manifest.json`,
 *      and the only writer of that manifest is `planRelease` (`lib/release-plan.js`), called by `run-release.mjs`.
 *   2. A bare `nx run-many -t version/publish` has no cross-project ordering: the per-dependency task edges were
 *      removed from `plugin.js`, so dependency-first order comes from `run-release.mjs`'s waves over the pending
 *      set. Publishing in the wrong order is refused by the publish executor's per-package guard, so the step
 *      would fail instead of publishing.
 *
 * Mirrors `executors/smoke-test/run-release.spec.mjs`'s convention: a static check against the REAL file text,
 * each positive assertion paired with a RED-equivalent negative control driven by a captured pre-fix source
 * constant (never by editing the workflow itself).
 *
 * Run: `node --test tools/nx-plugins/build/ci-publish-wiring.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, '../../../.github/workflows/pull-request.yml');
const source = readFileSync(workflowPath, 'utf8');

/**
 * The step's runnable lines only — comment lines (a `#` first non-blank
 * character) are stripped. The anti-pattern checks below are about the
 * COMMANDS the step runs, not prose: a comment that merely NAMES the removed
 * `nx affected -t version` shape (e.g. to explain why it is gone) must not be
 * counted as the anti-pattern itself.
 */
const codeOnly = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

/**
 * The exact PRE-FIX shape of the Publish step's version/publish phase: two
 * bare, unscoped `nx affected` calls with NO manifest minting anywhere. Held as
 * a constant so the negative control can drive the SAME matcher the positive
 * assertions use, WITHOUT ever editing the workflow.
 */
const PRE_FIX_PUBLISH_STEP = [
  '          else',
  '            npx nx affected -t build --exclude=$EXCLUDE --parallel=4',
  '            npx nx affected -t version --exclude=$EXCLUDE --parallel=4',
  '            npx nx affected -t publish --exclude=$EXCLUDE --configuration=production --parallel=4',
  '            echo "affected=$AFFECTED" >> $GITHUB_OUTPUT',
  '          fi',
].join('\n');

/**
 * The wiring predicate — true ONLY when `text` runs `run-release.mjs` with BOTH `--publish-only` and
 * `--configuration=production`, and contains no bare `nx run-many -t version|publish` of its own.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function workflowPublishesViaRunRelease(text) {
  const viaScript =
    /node\s+tools\/nx-plugins\/build\/executors\/smoke-test\/run-release\.mjs\s+--publish-only\s+--configuration=production/.test(text);
  const bareRunMany = /nx\s+run-many\s+-t\s+(version|publish)\b/.test(text);
  return viaScript && !bareRunMany;
}

test('sanity: the spec reads the REAL PR workflow (not a fixture)', () => {
  assert.match(
    source,
    /^name: PR$/m,
    `expected to read the real PR workflow at ${workflowPath}`
  );
});

test('Publish step: runs run-release.mjs --publish-only --configuration=production — the one entry that scopes, writes the manifest and orders', () => {
  assert.match(
    codeOnly,
    /node\s+tools\/nx-plugins\/build\/executors\/smoke-test\/run-release\.mjs\s+--publish-only\s+--configuration=production/,
    'expected the Publish step to call run-release.mjs --publish-only --configuration=production: it mints the run ' +
      'token, takes the scope from the pending set, writes the release manifest and runs version/publish in dependency waves'
  );
});

test('Publish step: no bare `nx run-many -t version|publish` remains (no cross-project ordering, no manifest)', () => {
  assert.ok(
    !/nx\s+run-many\s+-t\s+(version|publish)\b/.test(codeOnly),
    'found a runnable bare `nx run-many -t version|publish` in the workflow — it has no dependency ordering and writes no manifest'
  );
});

test('Publish step: KEEPS the affected build line', () => {
  assert.match(
    source,
    /npx nx affected -t build --exclude=\$EXCLUDE --parallel=4/,
    'expected the existing `nx affected -t build` line to be preserved — only the bare version/publish lines were to be replaced'
  );
});

test('Publish step: the OLD bare unscoped `nx affected -t version` NO LONGER exists', () => {
  assert.ok(
    !/nx affected -t version/.test(codeOnly),
    'found a runnable bare `nx affected -t version` — this is exactly the DEBT-RELEASE-UNSCOPED-PUBLISH-001 ' +
      'anti-pattern (and the dead CI path) the fix must fully remove, not merely supplement'
  );
});

test('Publish step: the OLD bare unscoped `nx affected -t publish` NO LONGER exists', () => {
  assert.ok(
    !/nx affected -t publish/.test(codeOnly),
    'found a runnable bare `nx affected -t publish` — it can never publish (manifest backstop) and must be fully removed'
  );
});

test('Publish step satisfies the composite wiring predicate', () => {
  assert.equal(workflowPublishesViaRunRelease(codeOnly), true, 'the real Publish step must satisfy workflowPublishesViaRunRelease');
});

test('RED-equivalent: the PRE-FIX Publish step does NOT satisfy the wiring predicate', () => {
  // Sanity first: the captured pre-fix constant must genuinely carry the
  // anti-pattern (a bare `nx affected -t publish`) — otherwise this control
  // would pass vacuously.
  assert.match(
    PRE_FIX_PUBLISH_STEP,
    /nx affected -t publish/,
    'sanity: the pre-fix constant must contain the bare `nx affected -t publish` line'
  );
  assert.equal(
    workflowPublishesViaRunRelease(PRE_FIX_PUBLISH_STEP),
    false,
    'the pre-fix text (bare unscoped affected version/publish, no minting) must FAIL the predicate — ' +
      'this is the RED half proving the positive assertion has teeth'
  );
});

test('RED-equivalent: the previous shape (scoped bare run-many version/publish) fails the predicate — scoped, but unordered and manifest-less', () => {
  const scopedBareRunMany =
    'npx nx run-many -t version --projects=$RELEASE_PROJECTS\nnpx nx run-many -t publish --projects=$RELEASE_PROJECTS --configuration=production';
  assert.equal(workflowPublishesViaRunRelease(scopedBareRunMany), false);
});

test('RED-equivalent: run-release.mjs WITHOUT --publish-only would re-run the gates and the smoke in CI, and fails the predicate', () => {
  assert.equal(
    workflowPublishesViaRunRelease('node tools/nx-plugins/build/executors/smoke-test/run-release.mjs --configuration=production'),
    false
  );
});
