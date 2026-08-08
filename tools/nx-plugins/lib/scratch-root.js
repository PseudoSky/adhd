'use strict';
/**
 * scratch-root.js — the single canonical definition of this repo's ephemeral
 * scratch-artifact root (AGENTS.md §10).
 *
 * Every tooling module that needs a path under the scratch root, or needs to
 * recognize one (the Nx `createNodes` project-inference exclusions, the
 * release-manifest publish gate, per-executor scratch dirs, the release-range
 * package.json walk), must `require()` this file rather than hardcoding the
 * root-segment literal itself. Before this module existed, that literal was
 * independently duplicated across 8+ call sites in this tooling layer alone —
 * exactly the kind of duplication that leaves a stale copy behind on the next
 * relocation and lets Nx start inferring phantom projects from scratch
 * content (see the historical incident this guards against, cited in
 * `lint/plugin.js` and `verify-dist-load/plugin.js`).
 *
 * Plain CommonJS, no build step, zero dependencies beyond `node:path`: this
 * file is loaded directly by Nx's `createNodes` graph-construction pass,
 * which runs BEFORE any project in the workspace has been built — it must
 * never depend on a package whose own `dist/` needs to exist first.
 *
 * SCOPE: this constant is for the repo's TOOLING layer (tools/nx-plugins/**)
 * only. Application-layer TS packages (e.g. apigen's IR cache, entrypoint
 * test fixtures) live in separate Nx-built packages that cannot `require()`
 * a plain unbuilt file outside their own project root without crossing Nx's
 * module boundaries — they each hold their own literal derived from this same
 * value. If the root ever moves again, update it here AND grep the workspace
 * for the old literal to catch those independent copies (tracked as
 * DEBT-BUILD-TOOLING-SCRATCH-ROOT-002 in the backlog: a real cross-runtime
 * shared constant would need its own publishable package).
 */
const { join } = require('node:path');

/** Ordered path segments of the scratch root, relative to the workspace root. */
const SCRATCH_ROOT_SEGMENTS = ['.adhd', 'tmp'];

/** OS-native relative path, e.g. '.adhd/tmp' (or '.adhd\\tmp' on Windows). */
const SCRATCH_ROOT_RELATIVE = join(...SCRATCH_ROOT_SEGMENTS);

/** Always-forward-slash form, for matching the POSIX-style project-root strings Nx's createNodes hands callbacks. */
const SCRATCH_ROOT_POSIX = SCRATCH_ROOT_SEGMENTS.join('/');

/** `'.adhd/tmp/'` — the prefix form used by `startsWith`/`includes` exclusion checks. */
const SCRATCH_ROOT_POSIX_PREFIX = `${SCRATCH_ROOT_POSIX}/`;

/**
 * Build an absolute path under the scratch root.
 * @param {string} workspaceRoot
 * @param {...string} segments
 * @returns {string}
 */
function scratchRootPath(workspaceRoot, ...segments) {
  return join(workspaceRoot, ...SCRATCH_ROOT_SEGMENTS, ...segments);
}

/**
 * True if a workspace-relative, POSIX-style path (e.g. an Nx project root
 * derived from a `package.json` path via `dirname`) falls under the scratch
 * root — the same shape as the old `p.startsWith('tmp/') || p.includes('/tmp/')`
 * checks this module replaces, now covering the `.adhd/tmp` root without
 * excluding the rest of `.adhd/` (e.g. `.adhd/workspace.json` must stay
 * visible to project inference).
 * @param {string} relativePosixPath
 * @returns {boolean}
 */
function isScratchPath(relativePosixPath) {
  return (
    relativePosixPath === SCRATCH_ROOT_POSIX ||
    relativePosixPath.startsWith(SCRATCH_ROOT_POSIX_PREFIX) ||
    relativePosixPath.includes(`/${SCRATCH_ROOT_POSIX_PREFIX}`)
  );
}

module.exports = {
  SCRATCH_ROOT_SEGMENTS,
  SCRATCH_ROOT_RELATIVE,
  SCRATCH_ROOT_POSIX,
  SCRATCH_ROOT_POSIX_PREFIX,
  scratchRootPath,
  isScratchPath,
};
