'use strict';
/**
 * lockfile-sync — keep `pnpm-lock.yaml` in step with the workspace's package.json
 * files, and detect when it is not.
 *
 * WHY (backlog 4f26493e AC2 / e98bb455 AC1). `pnpm release` bumps package
 * versions and dependents' ranges but never regenerates the lockfile, so the
 * release commit (7b85fa37) left `pnpm install --frozen-lockfile` failing with
 * ERR_PNPM_OUTDATED_LOCKFILE (repaired once by 88b49bf3). Two halves close it:
 *
 *   - `checkLockfile`  — NON-MUTATING freshness probe
 *       `pnpm install --frozen-lockfile --lockfile-only`
 *     (~0.4s, resolves nothing, writes nothing, exits non-zero with
 *     ERR_PNPM_OUTDATED_LOCKFILE on drift). The gate and `release:commit` use it.
 *   - `regenerateLockfile` — `pnpm install --lockfile-only --no-frozen-lockfile
 *     --prefer-offline`. `--no-frozen-lockfile` is explicit because pnpm defaults
 *     `frozen-lockfile` to true when `CI` is set, which would turn the regenerate
 *     into a no-op/failure. `--prefer-offline` + `--lockfile-only` re-links
 *     workspace packages (`link-workspace-packages=true` in .npmrc) from disk and
 *     only touches the registry for a spec that is genuinely new.
 *
 * Every process spawn goes through an injected `run(args, {cwd})` so callers and
 * unit tests can substitute it; the default shells out to `corepack pnpm`.
 */
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const CHECK_ARGS = ['install', '--frozen-lockfile', '--lockfile-only'];
const REGENERATE_ARGS = ['install', '--lockfile-only', '--no-frozen-lockfile', '--prefer-offline'];
const OUTDATED_CODE = 'ERR_PNPM_OUTDATED_LOCKFILE';

/** Default process runner: `corepack pnpm <args>` in `cwd`. */
function defaultRun(args, { cwd }) {
  const res = spawnSync('corepack', ['pnpm', ...args], { cwd, encoding: 'utf8' });
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || (res.error ? String(res.error) : '') };
}

/** True iff `cwd` is a pnpm workspace root that owns a lockfile. */
function hasPnpmLockfile(cwd) {
  return existsSync(join(cwd, 'pnpm-workspace.yaml')) && existsSync(join(cwd, 'pnpm-lock.yaml'));
}

/**
 * Diff two specifier maps into human lines naming each drifted dependency:
 *   `@adhd/x: lockfile "^1.0.0" vs package.json "^2.0.0"`.
 */
function diffSpecifiers(lock, pkg) {
  const lines = [];
  for (const name of [...new Set([...Object.keys(lock), ...Object.keys(pkg)])].sort()) {
    if (lock[name] === pkg[name]) continue;
    const l = name in lock ? JSON.stringify(lock[name]) : '<absent>';
    const p = name in pkg ? JSON.stringify(pkg[name]) : '<absent>';
    lines.push(`${name}: lockfile ${l} vs package.json ${p}`);
  }
  return lines;
}

/**
 * Parse pnpm's ERR_PNPM_OUTDATED_LOCKFILE stderr into
 * `{ manifest, drift[] }`. `manifest` is the offending package.json path (as
 * pnpm printed it); `drift` is the per-specifier diff. Either may be
 * `undefined`/empty when pnpm's wording differs — callers still have the raw text.
 */
function parseOutdatedLockfile(text) {
  const m = /not up to date with (\S+package\.json)/.exec(text);
  const s = /specifiers in the lockfile \((\{.*?\})\) don't match specs in package\.json \((\{.*?\})\)/s.exec(text);
  let drift = [];
  if (s) {
    try {
      drift = diffSpecifiers(JSON.parse(s[1]), JSON.parse(s[2]));
    } catch {
      drift = [];
    }
  }
  return { manifest: m ? m[1] : undefined, drift };
}

/**
 * Non-mutating freshness probe.
 * @returns {{ok:true}|{ok:false,kind:'stale',manifest?:string,drift:string[],message:string}|{ok:false,kind:'error',message:string}}
 *   `stale` = the lockfile drifted from a package.json (the defect this gate
 *   exists for); `error` = pnpm itself failed for another reason (not installed,
 *   corrupt lockfile…) — reported distinctly so it is never mistaken for drift.
 */
function checkLockfile({ cwd, run = defaultRun }) {
  const res = run(CHECK_ARGS, { cwd });
  if (res.status === 0) return { ok: true };
  const text = `${res.stderr}\n${res.stdout}`;
  if (text.includes(OUTDATED_CODE)) {
    const { manifest, drift } = parseOutdatedLockfile(text);
    const where = manifest ? ` vs ${manifest}` : '';
    const lines = drift.length ? `\n  ${drift.join('\n  ')}` : `\n${text.trim()}`;
    return {
      ok: false,
      kind: 'stale',
      manifest,
      drift,
      message: `pnpm-lock.yaml is stale${where}:${lines}\n  Fix: corepack pnpm install --lockfile-only --no-frozen-lockfile, then commit pnpm-lock.yaml.`,
    };
  }
  return { ok: false, kind: 'error', message: `pnpm lockfile check could not run (exit ${res.status}):\n${text.trim()}` };
}

/** Rewrite pnpm-lock.yaml from the current package.json files. @returns {{ok:boolean,message:string}} */
function regenerateLockfile({ cwd, run = defaultRun }) {
  const res = run(REGENERATE_ARGS, { cwd });
  if (res.status === 0) return { ok: true, message: '' };
  return { ok: false, message: `pnpm install --lockfile-only failed (exit ${res.status}):\n${`${res.stderr}\n${res.stdout}`.trim()}` };
}

const isManifest = (p) => p === 'package.json' || p.endsWith('/package.json');

/**
 * The release-commit step (e98bb455 AC1): when the release dirtied any
 * package.json and the lockfile no longer matches, regenerate it.
 *
 * `dryRun` never writes: it reports `would-regenerate` from the non-mutating probe.
 * @returns {{action:'skipped'|'fresh'|'regenerated'|'would-regenerate'|'failed', message?:string}}
 */
function syncLockfileForRelease({ cwd, dirtyPaths, dryRun = false, run = defaultRun }) {
  if (!hasPnpmLockfile(cwd)) return { action: 'skipped', message: 'no pnpm-workspace.yaml + pnpm-lock.yaml' };
  if (!dirtyPaths.some(isManifest)) return { action: 'skipped', message: 'no package.json changed' };
  const probe = checkLockfile({ cwd, run });
  if (probe.ok) return { action: 'fresh' };
  if (probe.kind === 'error') return { action: 'failed', message: probe.message };
  if (dryRun) return { action: 'would-regenerate', message: probe.message };
  const regen = regenerateLockfile({ cwd, run });
  if (!regen.ok) return { action: 'failed', message: regen.message };
  const after = checkLockfile({ cwd, run });
  if (!after.ok) return { action: 'failed', message: `lockfile still not fresh after regeneration: ${after.message}` };
  return { action: 'regenerated' };
}

module.exports = {
  CHECK_ARGS,
  REGENERATE_ARGS,
  checkLockfile,
  regenerateLockfile,
  syncLockfileForRelease,
  parseOutdatedLockfile,
  diffSpecifiers,
  hasPnpmLockfile,
};
