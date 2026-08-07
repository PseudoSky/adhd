'use strict';
/**
 * release-reset.js — detects and (optionally) surgically reverts a
 * PARTIAL/half-generated `nx release` artifact set for a single project:
 * a `CHANGELOG.md` entry asserting a version the project's `package.json`
 * never actually reached, and/or an orphaned `package.json` version bump
 * whose changelog step never ran.
 *
 * WHY THIS EXISTS (real, proven incident — see BACKLOG DEBT/FEAT item this
 * ships with): on 2026-08-07 a `nx release version`/changelog step ran
 * PARTIALLY and left `packages/apigen/apigen-base-logical/CHANGELOG.md` and
 * `packages/environment/environment-core-node/CHANGELOG.md` each carrying a
 * freshly-prepended `## 0.1.1 (2026-08-07)` / `## 0.1.4 (2026-08-07)` entry
 * while their `package.json` `version` fields were UNTOUCHED (still 0.1.0 /
 * 0.1.3) — no matching git tag, no matching npm publish, nothing. Those two
 * changelogs assert a release that exists nowhere. If swept into a commit
 * (this repo routinely has ~50 unrelated files dirty from concurrent agents
 * at any moment — see the "commit whatever is dirty" incident this module's
 * sibling guard, `.githooks/detect-mass-deletion.js`, exists to catch), that
 * commit ships permanently-wrong, only-supersedable metadata.
 *
 * SAFETY MODEL — read before changing anything below:
 *   - This module NEVER reverts a project whose `package.json` version and
 *     `CHANGELOG.md` top entry version agree (a real, IN-PROGRESS release —
 *     e.g. `@adhd/agent-mcp` 2.2.1 -> 2.2.2 with a matching changelog entry,
 *     just not tagged/published yet). That is normal, desired state.
 *   - A changelog is only ever proposed for revert when the ENTIRE working
 *     file equals `<new block><HEAD's exact file content>` — i.e. the only
 *     difference from HEAD is a clean prepended block. If a human or another
 *     agent also hand-edited elsewhere in the file, this module refuses to
 *     touch it (reports "needs manual review") rather than guess.
 *   - A `package.json` version field is only ever proposed for revert when
 *     the field is the ONLY thing that differs from HEAD's copy of the file
 *     (verified via a real line-level diff, not assumed) — so a version bump
 *     that arrived bundled with a legitimate, unrelated dependency-range edit
 *     (e.g. `apigen-cli`'s 0.2.2 -> 0.2.3 alongside internal `@adhd/*` range
 *     bumps) is never touched, because in that case the changelog top entry
 *     already agrees with the version anyway (not a revert candidate at all).
 *   - Nothing here ever runs `git restore <path>` / `git checkout HEAD --
 *     <path>` unless the safety checks above pass for THAT exact path. Never
 *     a whole-tree revert, never based on a glob.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

/** Matches `## 1.2.3 (2026-08-07)` or bare `## 1.2.3` changelog version headings
 * (the shape `nx release changelog`'s `projectChangelogs` renderer emits). */
const HEADING_RE = /^##\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)\b.*$/m;

/**
 * Extract the topmost `## <version>` block from a changelog's text.
 * @param {string|null} text
 * @returns {{ version: string, block: string } | null} `block` includes the
 *   heading line through (but not including) the next `## ` heading, or EOF.
 */
function topChangelogEntry(text) {
  if (!text) return null;
  const m = HEADING_RE.exec(text);
  if (!m) return null;
  const headingStart = m.index;
  const rest = text.slice(headingStart + m[0].length);
  const nextHeading = /^##\s+/m.exec(rest);
  const blockEnd = nextHeading ? headingStart + m[0].length + nextHeading.index : text.length;
  return { version: m[1], block: text.slice(headingStart, blockEnd) };
}

/**
 * Read a path's content from a given git ref, or `null` if the path did not
 * exist at that ref (new file). Throws on any OTHER git failure (fail-loud —
 * never silently treat a real git error as "file didn't exist").
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} relPath workspace-relative path (posix separators)
 */
function readAtRef(repoRoot, ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot, encoding: 'utf8' });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    if (/does not exist in|exists on disk, but not in|fatal: path .* does not exist/i.test(stderr)) {
      return null;
    }
    throw err;
  }
}

/** Read a path's CURRENT working-tree content, or `null` if it doesn't exist. */
function readWorking(repoRoot, relPath) {
  const abs = join(repoRoot, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/**
 * Find the highest-semver git tag matching `{projectName}@*` (this
 * workspace's `nx.json` `release.releaseTagPattern`). Returns `null` if none.
 */
function latestTag(repoRoot, projectName) {
  let out;
  try {
    out = execFileSync('git', ['tag', '-l', `${projectName}@*`], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return null;
  }
  const versions = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((t) => t.slice(projectName.length + 1))
    .filter((v) => /^[0-9]+\.[0-9]+\.[0-9]+/.test(v));
  if (versions.length === 0) return null;
  versions.sort(compareSemver);
  return versions[versions.length - 1];
}

/** Minimal semver comparator (numeric major.minor.patch; ignores prerelease
 * ordering nuances — sufficient for tag-freshness reporting, not a general
 * semver library). */
function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/**
 * Pure detector: given HEAD + working content for a project's package.json
 * and CHANGELOG.md (already read), plus the workspace's latest matching
 * release tag, compute the project's release state and any safe revert plan.
 *
 * Kept pure (no fs/git I/O) so it is exhaustively unit-testable; the executor
 * and CLI wire real file/git reads through `detectProjectReleaseState` below.
 *
 * @param {{
 *   projectName: string,
 *   changelogPath: string,
 *   packageJsonPath: string,
 *   pkgHeadText: string|null,
 *   pkgWorkingText: string|null,
 *   changelogHeadText: string|null,
 *   changelogWorkingText: string|null,
 *   latestTagVersion: string|null,
 * }} input
 */
function analyze(input) {
  const {
    projectName,
    changelogPath,
    packageJsonPath,
    pkgHeadText,
    pkgWorkingText,
    changelogHeadText,
    changelogWorkingText,
    latestTagVersion,
  } = input;

  const pkgHead = pkgHeadText ? JSON.parse(pkgHeadText) : null;
  const pkgWorking = pkgWorkingText ? JSON.parse(pkgWorkingText) : null;
  const pkgHeadVersion = pkgHead ? pkgHead.version : null;
  const pkgWorkingVersion = pkgWorking ? pkgWorking.version : null;

  const chHeadTop = topChangelogEntry(changelogHeadText);
  const chWorkingTop = topChangelogEntry(changelogWorkingText);

  const pkgDirty = pkgHeadText !== pkgWorkingText;
  const changelogDirty = changelogHeadText !== changelogWorkingText;

  // A NEW top changelog entry appeared, and its version does not match the
  // CURRENT package.json version, and it wasn't already the top entry at
  // HEAD (i.e. this is genuinely a freshly-inserted phantom block).
  const phantomChangelogEntry = Boolean(
    changelogDirty &&
      chWorkingTop &&
      chWorkingTop.version !== pkgWorkingVersion &&
      (!chHeadTop || chHeadTop.version !== chWorkingTop.version)
  );

  // package.json version moved but the changelog was never touched at all,
  // and doesn't already claim the new version (mirror-image partial run:
  // version step ran, changelog step didn't).
  const orphanVersionBump = Boolean(
    pkgDirty && !changelogDirty && chHeadTop && pkgWorkingVersion && chHeadTop.version !== pkgWorkingVersion
  );

  // Both moved TOGETHER to the same version — a normal in-progress release,
  // just not tagged/published yet. Never a revert candidate.
  const consistentInProgress = Boolean(
    pkgDirty && changelogDirty && chWorkingTop && pkgWorkingVersion && chWorkingTop.version === pkgWorkingVersion
  );

  const inconsistent = (phantomChangelogEntry || orphanVersionBump) && !consistentInProgress;

  const tagBehindWorking = Boolean(
    latestTagVersion && pkgWorkingVersion && latestTagVersion !== pkgWorkingVersion && !consistentInProgress
  );

  const actions = [];

  if (phantomChangelogEntry) {
    // Safe ONLY if the working file is exactly `<block><HEAD text>` — i.e.
    // the sole difference from HEAD is a clean prepend. Anything else means
    // a human/other-agent also touched the file; refuse to guess.
    const headText = changelogHeadText || '';
    const safe = changelogWorkingText != null && changelogWorkingText.endsWith(headText);
    actions.push({
      type: 'changelog-phantom-entry',
      path: changelogPath,
      phantomVersion: chWorkingTop.version,
      safe,
      reason: safe
        ? `CHANGELOG.md top entry "${chWorkingTop.version}" is not the package.json version ` +
          `("${pkgWorkingVersion}") and was cleanly prepended over HEAD's content — safe to revert to HEAD.`
        : `CHANGELOG.md top entry "${chWorkingTop.version}" is not the package.json version ` +
          `("${pkgWorkingVersion}"), but the file was NOT a clean prepend over HEAD — refusing to ` +
          `auto-revert; needs manual review.`,
    });
  }

  if (orphanVersionBump) {
    const diffIsVersionOnly = isVersionOnlyDiff(pkgHeadText, pkgWorkingText);
    actions.push({
      type: 'package-json-orphan-version',
      path: packageJsonPath,
      workingVersion: pkgWorkingVersion,
      headVersion: pkgHeadVersion,
      safe: diffIsVersionOnly,
      reason: diffIsVersionOnly
        ? `package.json version bumped to "${pkgWorkingVersion}" with no corresponding CHANGELOG.md ` +
          `entry, and the ONLY diff from HEAD is the version field — safe to revert.`
        : `package.json version bumped to "${pkgWorkingVersion}" with no corresponding CHANGELOG.md ` +
          `entry, but other fields also differ from HEAD — refusing to auto-revert; needs manual review.`,
    });
  }

  return {
    projectName,
    pkgHeadVersion,
    pkgWorkingVersion,
    changelogHeadVersion: chHeadTop ? chHeadTop.version : null,
    changelogWorkingVersion: chWorkingTop ? chWorkingTop.version : null,
    latestTagVersion,
    pkgDirty,
    changelogDirty,
    phantomChangelogEntry,
    orphanVersionBump,
    consistentInProgress,
    inconsistent,
    tagBehindWorking,
    actions,
  };
}

/**
 * True iff the ONLY textual difference between `headText` and `workingText`
 * (both raw package.json source) is the top-level `"version": "..."` line —
 * verified with a real line-level diff, never assumed from the parsed JSON
 * alone (parsed-JSON equality would miss key-order/whitespace churn and could
 * wrongly call a diff "version-only").
 */
function isVersionOnlyDiff(headText, workingText) {
  if (headText == null || workingText == null) return false;
  const headLines = headText.split('\n');
  const workingLines = workingText.split('\n');
  if (headLines.length !== workingLines.length) return false;
  let diffCount = 0;
  const versionLineRe = /^\s*"version"\s*:\s*".*"\s*,?\s*$/;
  for (let i = 0; i < headLines.length; i++) {
    if (headLines[i] === workingLines[i]) continue;
    diffCount++;
    if (!versionLineRe.test(headLines[i]) || !versionLineRe.test(workingLines[i])) return false;
  }
  return diffCount === 1;
}

/**
 * Real (I/O-performing) detector for one project. Reads HEAD + working
 * content via git/fs and delegates to the pure `analyze`.
 * @param {{ repoRoot: string, projectRoot: string, projectName: string }} opts
 */
function detectProjectReleaseState({ repoRoot, projectRoot, projectName }) {
  const packageJsonPath = join(projectRoot, 'package.json').split(require('node:path').sep).join('/');
  const changelogPath = join(projectRoot, 'CHANGELOG.md').split(require('node:path').sep).join('/');

  const pkgHeadText = readAtRef(repoRoot, 'HEAD', packageJsonPath);
  const pkgWorkingText = readWorking(repoRoot, packageJsonPath);
  const changelogHeadText = readAtRef(repoRoot, 'HEAD', changelogPath);
  const changelogWorkingText = readWorking(repoRoot, changelogPath);
  const latestTagVersion = latestTag(repoRoot, projectName);

  return analyze({
    projectName,
    changelogPath,
    packageJsonPath,
    pkgHeadText,
    pkgWorkingText,
    changelogHeadText,
    changelogWorkingText,
    latestTagVersion,
  });
}

/**
 * Apply a project's SAFE actions (mutating the working tree). Never called
 * unless the caller explicitly passed `--live` — dry-run is the default at
 * every call site above this function.
 * @param {string} repoRoot
 * @param {ReturnType<typeof analyze>} state
 * @returns {{ applied: string[], skipped: string[] }}
 */
function applyRevert(repoRoot, state) {
  const applied = [];
  const skipped = [];
  for (const action of state.actions) {
    if (!action.safe) {
      skipped.push(`${action.path} (${action.type}) — not safe, see reason`);
      continue;
    }
    if (action.type === 'changelog-phantom-entry') {
      // Single, explicit pathspec — never a whole-tree restore.
      execFileSync('git', ['restore', '--source=HEAD', '--', action.path], { cwd: repoRoot, stdio: 'pipe' });
      applied.push(`${action.path}: reverted phantom "${action.phantomVersion}" CHANGELOG.md entry`);
    } else if (action.type === 'package-json-orphan-version') {
      revertVersionLineOnly(repoRoot, action.path, action.workingVersion, action.headVersion);
      applied.push(`${action.path}: reverted orphaned version bump ${action.workingVersion} -> ${action.headVersion}`);
    }
  }
  return { applied, skipped };
}

/** Surgical single-line revert of package.json's version field (never a
 * whole-file restore — other fields in the working copy are left untouched,
 * by construction: this is only ever called after `isVersionOnlyDiff`
 * confirmed the version line is the sole difference). */
function revertVersionLineOnly(repoRoot, relPath, fromVersion, toVersion) {
  const { readFileSync, writeFileSync } = require('node:fs');
  const abs = join(repoRoot, relPath);
  const text = readFileSync(abs, 'utf8');
  const re = /"version"\s*:\s*"([^"]*)"/;
  const m = re.exec(text);
  if (!m || m[1] !== fromVersion) {
    throw new Error(`revertVersionLineOnly: ${relPath} version field is not "${fromVersion}" as expected — refusing.`);
  }
  writeFileSync(abs, text.replace(re, `"version": "${toVersion}"`), 'utf8');
}

module.exports = {
  topChangelogEntry,
  analyze,
  isVersionOnlyDiff,
  detectProjectReleaseState,
  applyRevert,
  latestTag,
  compareSemver,
  readAtRef,
  readWorking,
};
