/**
 * Structural (grep-based) teeth tests for the CI Publish wiring — proving that
 * `.github/workflows/pull-request.yml`'s `Publish` step MINTS the release
 * manifest the `publish` executor's backstop requires, instead of calling a
 * bare `nx affected -t version` / `-t publish` that can never publish.
 *
 * ROOT CAUSE this guards (already established — do not re-derive): a bare
 * `nx affected -t version/publish` can never publish, because
 * `executors/publish/impl.js:184` calls `checkPublishAllowed` FIRST and refuses
 * any project not listed in a fresh `.adhd/tmp/release-manifest.json`
 * (`lib/release-manifest.js:192-291`). The ONLY writer of that manifest is
 * `writeReleaseManifest` inside `computeChangedProjectSet`
 * (`lib/changed-set.js:346-348`), whose only caller is `run-release.mjs:222`.
 * The fix wires that scope computation — and therefore the manifest write —
 * into the CI step, then runs the version/publish phases scoped to it.
 *
 * Mirrors `executors/smoke-test/run-release.spec.mjs`'s convention: a static
 * check against the REAL file text, each positive assertion paired with a
 * RED-equivalent negative control driven by a captured PRE-FIX source constant
 * (never by editing the workflow itself).
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
 * The wiring predicate — true ONLY when `text` (a) calls
 * `computeChangedProjectSet(`, (b) mints/uses `RELEASE_RUN_TOKEN`, and (c) runs
 * BOTH `nx run-many -t version` and `nx run-many -t publish` scoped to the
 * computed `$RELEASE_PROJECTS`. Exported so the /tmp teeth proof can drive it
 * directly against the pre-fix text.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function workflowMintsReleaseScope(text) {
  const mintsScope = /computeChangedProjectSet\s*\(/.test(text);
  const mintsToken = /RELEASE_RUN_TOKEN/.test(text);
  const scopedVersion = /nx\s+run-many\s+-t\s+version\s+--projects=\$RELEASE_PROJECTS/.test(text);
  const scopedPublish =
    /nx\s+run-many\s+-t\s+publish\s+--projects=\$RELEASE_PROJECTS\s+--configuration=production/.test(text);
  return mintsScope && mintsToken && scopedVersion && scopedPublish;
}

test('sanity: the spec reads the REAL PR workflow (not a fixture)', () => {
  assert.match(source, /^name: PR$/m, `expected to read the real PR workflow at ${workflowPath}`);
});

test('Publish step: calls computeChangedProjectSet — the ONLY writer of the release manifest', () => {
  assert.match(
    source,
    /computeChangedProjectSet\s*\(/,
    'expected the Publish step to call computeChangedProjectSet( — without it no ' +
      '.adhd/tmp/release-manifest.json is written and every publish is refused by the backstop'
  );
});

test('Publish step: requires changed-set.js from its real workspace path', () => {
  assert.match(
    source,
    /require\("\.\/tools\/nx-plugins\/build\/lib\/changed-set\.js"\)/,
    'expected the `node -e` to require ./tools/nx-plugins/build/lib/changed-set.js — the shared resolver, not a reinvented inline scope'
  );
});

test('Publish step: mints a RELEASE_RUN_TOKEN (run-scoped freshness)', () => {
  assert.match(
    source,
    /RELEASE_RUN_TOKEN/,
    'expected the Publish step to export a RELEASE_RUN_TOKEN — it stamps the manifest so the ' +
      "publish executor's age gate is skipped for this run's own manifest"
  );
});

test('Publish step: runs a run-many -t version scoped to $RELEASE_PROJECTS', () => {
  assert.match(
    source,
    /nx\s+run-many\s+-t\s+version\s+--projects=\$RELEASE_PROJECTS/,
    'expected `nx run-many -t version --projects=$RELEASE_PROJECTS` — a bare `nx affected -t version` leaves the manifest un-minted and is unscoped'
  );
});

test('Publish step: runs a run-many -t publish --configuration=production scoped to $RELEASE_PROJECTS', () => {
  assert.match(
    source,
    /nx\s+run-many\s+-t\s+publish\s+--projects=\$RELEASE_PROJECTS\s+--configuration=production/,
    'expected `nx run-many -t publish --projects=$RELEASE_PROJECTS --configuration=production` — scoped to the computed changed-set'
  );
});

test('Publish step: KEEPS the affected build line', () => {
  assert.match(
    source,
    /npx nx affected -t build --exclude=\$EXCLUDE --parallel=4/,
    'expected the existing `nx affected -t build` line to be preserved — only the bare version/publish lines were to be replaced'
  );
});

test('Publish step: skips cleanly (no version/publish) when the changed-set is empty', () => {
  assert.match(
    source,
    /if \[ -z "\$RELEASE_PROJECTS" \]; then/,
    'expected an empty-changed-set guard so an empty computed scope echoes a no-projects line and skips version/publish'
  );
  assert.match(
    source,
    /No projects in the computed release changed-set/,
    'expected a clear "nothing to version/publish" line for the empty-changed-set case'
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

test('Publish step satisfies the composite wiring predicate (scope + token + both scoped run-many phases)', () => {
  assert.equal(
    workflowMintsReleaseScope(source),
    true,
    'the real (post-fix) Publish step must satisfy every conjunct of workflowMintsReleaseScope'
  );
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
    workflowMintsReleaseScope(PRE_FIX_PUBLISH_STEP),
    false,
    'the pre-fix text (bare unscoped affected version/publish, no minting) must FAIL the predicate — ' +
      'this is the RED half proving the positive assertion has teeth'
  );
});

test('RED-equivalent: scoped run-many phases WITHOUT manifest minting still fail the predicate', () => {
  // Proves the predicate cannot be satisfied by the run-many shape alone — the
  // manifest minting (computeChangedProjectSet) and the token are load-bearing
  // conjuncts, not incidental.
  const scopedWithoutMinting =
    'npx nx run-many -t version --projects=foo && npx nx run-many -t publish --projects=foo --configuration=production';
  assert.equal(
    workflowMintsReleaseScope(scopedWithoutMinting),
    false,
    'a scoped run-many version/publish with NO computeChangedProjectSet/RELEASE_RUN_TOKEN must still fail — ' +
      'the run-many shape alone does not mint the manifest the backstop demands'
  );
});

test('RED-equivalent: minting the token + scope but publishing UNSCOPED still fails the predicate', () => {
  // The complementary half: a step that mints a fresh manifest but then runs a
  // bare `nx affected -t publish` would still execute off the computed scope's
  // guarantee — the predicate must reject it.
  const mintedButUnscoped =
    'export RELEASE_RUN_TOKEN=$(uuidgen)\nconst {computeChangedProjectSet}=require("./tools/nx-plugins/build/lib/changed-set.js")\nnpx nx affected -t publish --configuration=production';
  assert.equal(
    workflowMintsReleaseScope(mintedButUnscoped),
    false,
    'minting the manifest then publishing via a bare `nx affected` must still fail — publish must be scoped to $RELEASE_PROJECTS'
  );
});
