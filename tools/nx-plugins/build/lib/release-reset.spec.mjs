/**
 * Teeth tests for release-reset.js — the phantom-changelog / orphaned-
 * version-bump detector+revertor behind `@adhd/nx-build:release-reset`
 * (FEAT-RELEASE-RESET-001).
 *
 * Reconstructs the REAL incident shape on 2026-08-07 (a `CHANGELOG.md`
 * asserting a version `package.json` never reached — see
 * `packages/apigen/apigen-base-logical` / `packages/environment/
 * environment-core-node` at that date) against a disposable, real git repo
 * under `os.tmpdir()` — never a mock of git itself for the integration path
 * — plus pure unit coverage of `analyze()`'s decision logic. Negative
 * controls prove it leaves a normal in-progress release (package.json +
 * CHANGELOG.md bumped TOGETHER, just not tagged yet — e.g. this repo's real
 * `@adhd/agent-mcp` 2.2.1 -> 2.2.2) completely untouched, and that a
 * phantom-shaped changelog with an ADDITIONAL hand-edit elsewhere in the
 * file is refused rather than guessed at.
 *
 * Run: `node --test tools/nx-plugins/build/lib/release-reset.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { analyze, isVersionOnlyDiff, detectProjectReleaseState, applyRevert, topChangelogEntry } = require('./release-reset.js');

// ─── Pure analyze() unit coverage ──────────────────────────────────────────

test('analyze: clean tree (no diff at all) is never inconsistent', () => {
  const pkg = '{\n  "name": "@adhd/x",\n  "version": "0.1.0"\n}\n';
  const changelog = '## 0.1.0 (2026-08-01)\n\ninitial\n';
  const state = analyze({
    projectName: 'x',
    changelogPath: 'packages/x/CHANGELOG.md',
    packageJsonPath: 'packages/x/package.json',
    pkgHeadText: pkg,
    pkgWorkingText: pkg,
    changelogHeadText: changelog,
    changelogWorkingText: changelog,
    latestTagVersion: '0.1.0',
  });
  assert.equal(state.inconsistent, false);
  assert.deepEqual(state.actions, []);
});

test('analyze: real incident shape — CHANGELOG-only phantom entry (apigen-base-logical/environment-core-node style)', () => {
  const pkgHead = '{\n  "name": "@adhd/apigen-base-logical",\n  "version": "0.1.0"\n}\n';
  const changelogHead = '## 0.1.0 (2026-07-20)\n\ninitial\n';
  const phantomBlock = '## 0.1.1 (2026-08-07)\n\n\n### Features\n\n- fill JAVA_COLUMN codec expressions\n\n';
  const changelogWorking = phantomBlock + changelogHead;

  const state = analyze({
    projectName: 'apigen-base-logical',
    changelogPath: 'packages/apigen/apigen-base-logical/CHANGELOG.md',
    packageJsonPath: 'packages/apigen/apigen-base-logical/package.json',
    pkgHeadText: pkgHead,
    pkgWorkingText: pkgHead, // package.json was NEVER touched — the real bug
    changelogHeadText: changelogHead,
    changelogWorkingText: changelogWorking,
    latestTagVersion: '0.1.0',
  });

  assert.equal(state.phantomChangelogEntry, true);
  assert.equal(state.orphanVersionBump, false);
  assert.equal(state.consistentInProgress, false);
  assert.equal(state.inconsistent, true);
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].type, 'changelog-phantom-entry');
  assert.equal(state.actions[0].safe, true);
  assert.equal(state.actions[0].phantomVersion, '0.1.1');
});

test('analyze: mirror shape — package.json bumped, changelog never touched (orphan version bump)', () => {
  const pkgHead = '{\n  "name": "@adhd/x",\n  "version": "0.1.0"\n}\n';
  const pkgWorking = '{\n  "name": "@adhd/x",\n  "version": "0.1.1"\n}\n';
  const changelog = '## 0.1.0 (2026-07-20)\n\ninitial\n';

  const state = analyze({
    projectName: 'x',
    changelogPath: 'packages/x/CHANGELOG.md',
    packageJsonPath: 'packages/x/package.json',
    pkgHeadText: pkgHead,
    pkgWorkingText: pkgWorking,
    changelogHeadText: changelog,
    changelogWorkingText: changelog,
    latestTagVersion: '0.1.0',
  });

  assert.equal(state.orphanVersionBump, true);
  assert.equal(state.phantomChangelogEntry, false);
  assert.equal(state.inconsistent, true);
  assert.equal(state.actions[0].type, 'package-json-orphan-version');
  assert.equal(state.actions[0].safe, true);
});

test('analyze: NEGATIVE CONTROL — consistent in-progress bump (agent-mcp/apigen-cli style) is left alone', () => {
  const pkgHead = '{\n  "name": "@adhd/agent-mcp",\n  "version": "2.2.1"\n}\n';
  const pkgWorking = '{\n  "name": "@adhd/agent-mcp",\n  "version": "2.2.2"\n}\n';
  const changelogHead = '## 2.2.1 (2026-07-27)\n\nfixes BUG-011\n';
  const changelogWorking = '## 2.2.2 (2026-08-07)\n\n\n### Fixes\n\n- eliminate double-import flakiness\n\n' + changelogHead;

  const state = analyze({
    projectName: 'agent-mcp',
    changelogPath: 'entrypoint/agent-mcp/CHANGELOG.md',
    packageJsonPath: 'entrypoint/agent-mcp/package.json',
    pkgHeadText: pkgHead,
    pkgWorkingText: pkgWorking,
    changelogHeadText: changelogHead,
    changelogWorkingText: changelogWorking,
    latestTagVersion: '2.1.1',
  });

  assert.equal(state.consistentInProgress, true);
  assert.equal(state.phantomChangelogEntry, false);
  assert.equal(state.orphanVersionBump, false);
  assert.equal(state.inconsistent, false, 'a real, matched in-progress bump must never be flagged inconsistent');
  assert.deepEqual(state.actions, []);
  assert.equal(state.tagBehindWorking, false, 'consistentInProgress suppresses the merely-informational tag note');
});

test('analyze: a phantom-shaped changelog with an ADDITIONAL hand-edit elsewhere is refused, not guessed', () => {
  const pkgHead = '{\n  "name": "@adhd/x",\n  "version": "0.1.0"\n}\n';
  const changelogHead = '## 0.1.0 (2026-07-20)\n\ninitial\n';
  // Someone also edited the OLD block's text, not just prepended — working
  // text does NOT end with headText verbatim.
  const changelogWorking = '## 0.1.1 (2026-08-07)\n\nphantom\n\n## 0.1.0 (2026-07-20)\n\nHAND-EDITED NOTE\n';

  const state = analyze({
    projectName: 'x',
    changelogPath: 'packages/x/CHANGELOG.md',
    packageJsonPath: 'packages/x/package.json',
    pkgHeadText: pkgHead,
    pkgWorkingText: pkgHead,
    changelogHeadText: changelogHead,
    changelogWorkingText: changelogWorking,
    latestTagVersion: '0.1.0',
  });

  assert.equal(state.phantomChangelogEntry, true);
  assert.equal(state.actions[0].safe, false, 'must refuse to auto-revert a file that was also hand-edited');
});

test('analyze: an orphan version bump bundled with an unrelated dependency-range edit is refused, not guessed', () => {
  const pkgHead = '{\n  "name": "@adhd/x",\n  "version": "0.1.0",\n  "dependencies": {\n    "@adhd/y": "^0.1.0"\n  }\n}\n';
  const pkgWorking = '{\n  "name": "@adhd/x",\n  "version": "0.1.1",\n  "dependencies": {\n    "@adhd/y": "^0.2.0"\n  }\n}\n';
  const changelog = '## 0.1.0 (2026-07-20)\n\ninitial\n';

  const state = analyze({
    projectName: 'x',
    changelogPath: 'packages/x/CHANGELOG.md',
    packageJsonPath: 'packages/x/package.json',
    pkgHeadText: pkgHead,
    pkgWorkingText: pkgWorking,
    changelogHeadText: changelog,
    changelogWorkingText: changelog,
    latestTagVersion: '0.1.0',
  });

  assert.equal(state.orphanVersionBump, true);
  assert.equal(state.actions[0].safe, false, 'must refuse — the version line is not the ONLY diff');
});

test('topChangelogEntry: parses heading + block boundary correctly', () => {
  const text = '## 1.2.3 (2026-08-07)\n\nbody\n\n## 1.2.2 (2026-08-01)\n\nolder\n';
  const entry = topChangelogEntry(text);
  assert.equal(entry.version, '1.2.3');
  assert.equal(entry.block, '## 1.2.3 (2026-08-07)\n\nbody\n\n');
});

test('isVersionOnlyDiff: true only when the version line is the sole difference', () => {
  const a = '{\n  "version": "0.1.0"\n}\n';
  const b = '{\n  "version": "0.1.1"\n}\n';
  assert.equal(isVersionOnlyDiff(a, b), true);
  const c = '{\n  "version": "0.1.1",\n  "extra": true\n}\n';
  assert.equal(isVersionOnlyDiff(a, c), false);
});

// ─── Integration: real disposable git repo, real git commands ─────────────

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-reset-it-'));
  sh(root, ['init', '-q']);
  sh(root, ['config', 'user.email', 'test@example.com']);
  sh(root, ['config', 'user.name', 'Test']);
  return root;
}

function commitAll(root, message) {
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '-m', message]);
}

test('integration: reverts a REAL phantom CHANGELOG.md entry on disk, leaves package.json alone, --live', () => {
  const root = makeRepo();
  try {
    const projectRoot = 'packages/apigen/apigen-base-logical';
    mkdirSync(join(root, projectRoot), { recursive: true });
    const pkgPath = join(root, projectRoot, 'package.json');
    const changelogPath = join(root, projectRoot, 'CHANGELOG.md');
    const pkgText = '{\n  "name": "@adhd/apigen-base-logical",\n  "version": "0.1.0"\n}\n';
    const changelogText = '## 0.1.0 (2026-07-20)\n\ninitial\n';
    writeFileSync(pkgPath, pkgText);
    writeFileSync(changelogPath, changelogText);
    commitAll(root, 'initial 0.1.0');

    // Simulate the partial release run: only CHANGELOG.md gets a phantom entry.
    const phantomText = '## 0.1.1 (2026-08-07)\n\n\n### Features\n\n- fill JAVA_COLUMN codec expressions\n\n' + changelogText;
    writeFileSync(changelogPath, phantomText);

    // An unrelated file elsewhere in the repo, belonging to "another agent" —
    // must be completely untouched by release-reset.
    mkdirSync(join(root, 'packages/other'), { recursive: true });
    writeFileSync(join(root, 'packages/other/scratch.txt'), 'someone else\'s in-progress work\n');

    const state = detectProjectReleaseState({ repoRoot: root, projectRoot, projectName: 'apigen-base-logical' });
    assert.equal(state.inconsistent, true);
    assert.equal(state.actions[0].safe, true);

    const { applied, skipped } = applyRevert(root, state);
    assert.equal(skipped.length, 0);
    assert.equal(applied.length, 1);

    assert.equal(readFileSync(changelogPath, 'utf8'), changelogText, 'CHANGELOG.md must be reverted to HEAD content');
    assert.equal(readFileSync(pkgPath, 'utf8'), pkgText, 'package.json was never touched by release-reset');
    assert.equal(
      readFileSync(join(root, 'packages/other/scratch.txt'), 'utf8'),
      'someone else\'s in-progress work\n',
      'unrelated dirty file elsewhere in the repo must be completely untouched'
    );

    // Idempotent: running again on the now-clean project is a no-op.
    const state2 = detectProjectReleaseState({ repoRoot: root, projectRoot, projectName: 'apigen-base-logical' });
    assert.equal(state2.inconsistent, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: NEGATIVE CONTROL — a real consistent in-progress bump is never touched, even with --live', () => {
  const root = makeRepo();
  try {
    const projectRoot = 'entrypoint/agent-mcp';
    mkdirSync(join(root, projectRoot), { recursive: true });
    const pkgPath = join(root, projectRoot, 'package.json');
    const changelogPath = join(root, projectRoot, 'CHANGELOG.md');
    writeFileSync(pkgPath, '{\n  "name": "@adhd/agent-mcp",\n  "version": "2.2.1"\n}\n');
    writeFileSync(changelogPath, '## 2.2.1 (2026-07-27)\n\nfixes BUG-011\n');
    commitAll(root, 'initial 2.2.1');

    // Legit in-progress bump: BOTH files move together to 2.2.2.
    const bumpedPkg = '{\n  "name": "@adhd/agent-mcp",\n  "version": "2.2.2"\n}\n';
    const bumpedChangelog =
      '## 2.2.2 (2026-08-07)\n\n\n### Fixes\n\n- eliminate double-import flakiness\n\n## 2.2.1 (2026-07-27)\n\nfixes BUG-011\n';
    writeFileSync(pkgPath, bumpedPkg);
    writeFileSync(changelogPath, bumpedChangelog);

    const state = detectProjectReleaseState({ repoRoot: root, projectRoot, projectName: 'agent-mcp' });
    assert.equal(state.inconsistent, false);

    const { applied, skipped } = applyRevert(root, state);
    assert.deepEqual(applied, []);
    assert.deepEqual(skipped, []);

    assert.equal(readFileSync(pkgPath, 'utf8'), bumpedPkg, 'legit version bump must survive untouched');
    assert.equal(readFileSync(changelogPath, 'utf8'), bumpedChangelog, 'legit changelog entry must survive untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: clean tree is a true no-op (idempotence)', () => {
  const root = makeRepo();
  try {
    const projectRoot = 'packages/x';
    mkdirSync(join(root, projectRoot), { recursive: true });
    writeFileSync(join(root, projectRoot, 'package.json'), '{\n  "name": "@adhd/x",\n  "version": "0.1.0"\n}\n');
    writeFileSync(join(root, projectRoot, 'CHANGELOG.md'), '## 0.1.0 (2026-07-20)\n\ninitial\n');
    commitAll(root, 'initial');

    const state = detectProjectReleaseState({ repoRoot: root, projectRoot, projectName: 'x' });
    assert.equal(state.inconsistent, false);
    const { applied, skipped } = applyRevert(root, state);
    assert.deepEqual(applied, []);
    assert.deepEqual(skipped, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
