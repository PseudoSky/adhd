'use strict';
/**
 * release-manifest.js — the `publish` executor's LAST-LINE-OF-DEFENSE
 * backstop (Phase 3 of `tmp/release-pipeline-audit.md`).
 *
 * `changed-set.js`'s `computeChangedProjectSet` already computes the
 * authoritative "what should publish this run" project list, and
 * `run-release.mjs` already passes it to `nx run-many -t publish
 * --projects=<list>`. That is sufficient for the sanctioned entrypoint — but
 * it is enforced entirely OUTSIDE the `publish` task itself. If something
 * upstream ever bypasses `run-release.mjs` (a hand-typed
 * `nx run-many -t publish`, a single `nx run <project>:publish`, a future
 * script that forgets `--projects=`), nothing inside the `publish` executor
 * itself would notice or object — the task graph would happily run for every
 * publishable project in the workspace again, exactly the anti-pattern the
 * changed-set resolver was built to eliminate.
 *
 * This module closes that gap from the INSIDE: `computeChangedProjectSet`
 * writes its computed list here (`writeReleaseManifest`, called from
 * `changed-set.js`), and `executors/publish/impl.js` calls
 * `checkPublishAllowed` before it will run a real `npm publish` — refusing
 * unless the invoking project is listed in a FRESH manifest.
 *
 * MANIFEST LOCATION: `<workspaceRoot>/tmp/release-manifest.json` — ephemeral,
 * gitignored, per this repo's "ephemeral artifacts live under tmp/, always
 * cleaned, never tracked" convention (AGENTS.md/CLAUDE.md §10). This is NOT
 * the committed `published-state.json` cache (that answers "is this exact
 * version already on the registry"; this answers "did THIS release run
 * decide this project is in scope").
 *
 * FRESHNESS WINDOW: 10 minutes (`MANIFEST_MAX_AGE_MS`). Chosen because a real
 * `pnpm release` run's own sequence — computing the scope, then an explicit
 * `version` phase, GATE 1, then `publish` for ~15-30 projects (this repo's
 * typical batch size per the audit's Phase 2 measurement) — completes in low
 * single-digit minutes on a normal machine; 10 minutes gives a comfortable
 * multiple of that without being so long that a manifest from a stale,
 * abandoned, hours-old attempt could still validate a much-later ad hoc
 * publish. A caller doing a genuinely slow release (e.g. throttled by a large
 * batch or network contention) can always re-run the changed-set computation
 * to refresh the manifest, or use the explicit override below.
 *
 * OVERRIDE: `RELEASE_FORCE_FULL_PUBLISH=1` + a non-empty
 * `RELEASE_FORCE_REASON="..."` bypasses the check entirely. This mirrors this
 * repo's own established convention for exceptional/dismissed transitions —
 * `entrypoint/backlog`'s `transitionStatus` throws `ReasonRequiredError` for
 * any transition into a terminal-dismissed status with no reason
 * (`entrypoint/backlog/src/store/lifecycle.ts:34-36`) and persists the reason
 * as an auditable note (`lifecycle.ts:41`, `writeAuditEvent` at `:54`). Here,
 * every override use is appended to `tmp/release-manifest-overrides.log`
 * (`logOverride`) — never silent.
 *
 * @module release-manifest
 */
const { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } = require('node:fs');
const { join, dirname } = require('node:path');

const MANIFEST_RELATIVE_PATH = join('tmp', 'release-manifest.json');
const OVERRIDE_LOG_RELATIVE_PATH = join('tmp', 'release-manifest-overrides.log');

/** See the module header's "FRESHNESS WINDOW" section for the rationale. */
const MANIFEST_MAX_AGE_MS = 10 * 60 * 1000;

function manifestPath(workspaceRoot) {
  return join(workspaceRoot, MANIFEST_RELATIVE_PATH);
}

function overrideLogPath(workspaceRoot) {
  return join(workspaceRoot, OVERRIDE_LOG_RELATIVE_PATH);
}

/**
 * Write the computed changed-set project list as the release manifest —
 * called from `changed-set.js`'s `computeChangedProjectSet` immediately after
 * it resolves the scope, so every code path that legitimately computes a
 * scope also, by construction, produces the backstop's evidence.
 *
 * @param {string} workspaceRoot
 * @param {string[]} projectNames nx project names in scope (e.g. "agent-base-types")
 * @param {{ baseRef?: string, now?: number }} [opts]
 * @returns {{generatedAt: string, baseRef: string|null, projectNames: string[]}}
 */
function writeReleaseManifest(workspaceRoot, projectNames, opts = {}) {
  if (!Array.isArray(projectNames)) {
    throw new Error('release-manifest: writeReleaseManifest requires projectNames to be an array');
  }
  const p = manifestPath(workspaceRoot);
  mkdirSync(dirname(p), { recursive: true });
  const manifest = {
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    baseRef: opts.baseRef ?? null,
    projectNames: [...projectNames].sort(),
  };
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * Read the release manifest. A missing or corrupt file returns `null` — never
 * throws — so `checkPublishAllowed` can treat "no manifest" as its own
 * distinct, clearly-reported refusal reason rather than an unhandled crash.
 *
 * @param {string} workspaceRoot
 * @returns {{generatedAt: string, baseRef: string|null, projectNames: string[]} | null}
 */
function readReleaseManifest(workspaceRoot) {
  const p = manifestPath(workspaceRoot);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.generatedAt !== 'string' ||
      !Array.isArray(parsed.projectNames)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** @returns {number} milliseconds since the manifest was generated (Infinity if unparsable). */
function manifestAgeMs(manifest, now = Date.now()) {
  const generatedAtMs = Date.parse(manifest.generatedAt);
  if (Number.isNaN(generatedAtMs)) return Infinity;
  return now - generatedAtMs;
}

/**
 * Append an auditable record of an override use. `appendFileSync` with the
 * default append flag is a single small write, atomic on POSIX filesystems —
 * concurrent overrides (unlikely, but not impossible if several `publish`
 * tasks are force-run in parallel) interleave as separate lines, never
 * corrupt one another. Deliberately NOT run through `lib/file-lock.js`'s
 * mutex: this is a strictly-append audit trail, not a read-modify-write
 * cache, so the stronger lock isn't needed.
 */
function logOverride(workspaceRoot, entry) {
  const p = overrideLogPath(workspaceRoot);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + '\n');
}

/**
 * The actual backstop decision. Called from `executors/publish/impl.js`
 * before it will run a real `npm publish`.
 *
 * @param {{
 *   workspaceRoot: string,
 *   projectName: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 *   maxAgeMs?: number,
 * }} opts
 * @returns {{ allowed: boolean, forced: boolean, reason: string }}
 */
function checkPublishAllowed(opts) {
  if (!opts || !opts.workspaceRoot || !opts.projectName) {
    throw new Error('release-manifest: checkPublishAllowed requires { workspaceRoot, projectName }');
  }
  const { workspaceRoot, projectName } = opts;
  const env = opts.env || process.env;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? MANIFEST_MAX_AGE_MS;

  const forceFlagRaw = String(env.RELEASE_FORCE_FULL_PUBLISH || '').trim().toLowerCase();
  const forceFlag = forceFlagRaw !== '' && forceFlagRaw !== '0' && forceFlagRaw !== 'false';
  const forceReason = String(env.RELEASE_FORCE_REASON || '').trim();

  if (forceFlag) {
    if (!forceReason) {
      return {
        allowed: false,
        forced: false,
        reason:
          `RELEASE_FORCE_FULL_PUBLISH is set but RELEASE_FORCE_REASON is empty — a non-empty reason is required ` +
          `to bypass the release-manifest backstop (mirrors entrypoint/backlog's requiresReason convention for ` +
          `terminal-dismissed transitions). Refusing to publish ${projectName}. Set RELEASE_FORCE_REASON="..." to proceed.`,
      };
    }
    logOverride(workspaceRoot, {
      at: new Date(now).toISOString(),
      projectName,
      reason: forceReason,
      actor: env.USER || env.USERNAME || 'unknown',
    });
    return {
      allowed: true,
      forced: true,
      reason: `RELEASE_FORCE_FULL_PUBLISH override used for ${projectName} — reason: "${forceReason}" (logged to ${OVERRIDE_LOG_RELATIVE_PATH}).`,
    };
  }

  const manifest = readReleaseManifest(workspaceRoot);
  if (!manifest) {
    return {
      allowed: false,
      forced: false,
      reason:
        `no release manifest found at ${MANIFEST_RELATIVE_PATH} — this publish executor only trusts a manifest ` +
        `written by tools/nx-plugins/build/lib/changed-set.js's computeChangedProjectSet (i.e. going through ` +
        `'pnpm release' / run-release.mjs). Refusing to publish ${projectName} outside that computed scope. ` +
        `Override with RELEASE_FORCE_FULL_PUBLISH=1 and a non-empty RELEASE_FORCE_REASON="..." if this is genuinely intentional.`,
    };
  }

  const age = manifestAgeMs(manifest, now);
  if (age > maxAgeMs) {
    return {
      allowed: false,
      forced: false,
      reason:
        `release manifest at ${MANIFEST_RELATIVE_PATH} is stale (generated ${manifest.generatedAt}, ` +
        `${Math.round(age / 1000)}s ago, max age ${Math.round(maxAgeMs / 1000)}s) — refusing to publish ` +
        `${projectName} against a scope that may no longer reflect the current changed-set. Re-run 'pnpm release' ` +
        `(or the changed-set computation) to refresh the manifest, or override with RELEASE_FORCE_FULL_PUBLISH=1 ` +
        `and a non-empty RELEASE_FORCE_REASON="...".`,
    };
  }

  if (!manifest.projectNames.includes(projectName)) {
    return {
      allowed: false,
      forced: false,
      reason:
        `${projectName} is not listed in the release manifest's computed scope ` +
        `(${manifest.projectNames.length} project(s): ${manifest.projectNames.join(', ') || '(none)'}) — refusing ` +
        `to publish a project outside the computed changed-set. Override with RELEASE_FORCE_FULL_PUBLISH=1 and a ` +
        `non-empty RELEASE_FORCE_REASON="..." if this is genuinely intentional.`,
    };
  }

  return {
    allowed: true,
    forced: false,
    reason: `${projectName} is listed in a fresh (${Math.round(age / 1000)}s old) release manifest.`,
  };
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  OVERRIDE_LOG_RELATIVE_PATH,
  MANIFEST_MAX_AGE_MS,
  manifestPath,
  overrideLogPath,
  writeReleaseManifest,
  readReleaseManifest,
  manifestAgeMs,
  logOverride,
  checkPublishAllowed,
};
