/**
 * context — what is true of a whole test run, and how a test result becomes a stored record.
 *
 * Shared by the vitest and node:test reporters so both write the same record shape (SCHEMA_VERSION 1):
 *   kind 'test': project, file (repo-relative), name (full), tier, tierSource, outcome (pass|fail|skip|todo),
 *                durationMs, retryCount, runId, runner, group, gitSha, dirty, branch, mainline, ts, loadAvgStart
 *   kind 'run':  the same run fields plus wallMs, tests, reporterMs (the reporter's own cost in the run)
 *
 * `dirty` is true/false, or null when git could not say; flake detection treats anything but false as not-the-same-code.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpus, loadavg } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './store.mjs';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../lib/git-env.js');

/** The repository root this module lives in (tools/nx-plugins/test/metrics -> root). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function git(cwd, args, env) {
  return new Promise((resolveGit) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, env: cleanGitEnv(env) }, (err, stdout) => {
      resolveGit({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? '').trim() });
    });
  });
}

/**
 * The code identity of a run. The three lookups run concurrently and asynchronously, so a reporter can start them when
 * the run starts and read the answer when it ends, off the test run's critical path.
 * @returns {Promise<{ gitSha: string|null, dirty: boolean|null, branch: string|null, mainline: boolean|null }>}
 */
export async function gitInfo(cwd = process.cwd(), env = process.env) {
  const [sha, status, branch, anc] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD'], env),
    git(cwd, ['status', '--porcelain', '--untracked-files=no'], env),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], env),
    git(cwd, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], env),
  ]);
  if (sha.status !== 0 || sha.out === '') return { gitSha: null, dirty: null, branch: null, mainline: null };
  const name = branch.status === 0 ? branch.out : null;
  return {
    gitSha: sha.out,
    dirty: status.status === 0 ? status.out !== '' : null,
    branch: name,
    mainline: name === 'main' || anc.status === 0,
  };
}

/**
 * Begin a run: one id, one timestamp, one load average (taken now), and the git lookup (awaited here, so call this
 * without awaiting at run start and await the promise when the run ends).
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, runner: 'vitest'|'node-test', now?: () => Date, git?: typeof gitInfo }} opts
 */
export async function beginRun({ env = process.env, cwd = process.cwd(), runner, now = () => new Date(), git: gitFn = gitInfo }) {
  const base = {
    runId: randomUUID(),
    runner,
    group: env.ADHD_TEST_RUN_GROUP || null,
    startedAt: now().toISOString(),
    loadAvgStart: Math.round(loadavg()[0] * 100) / 100,
    cpus: cpus().length,
    ci: Boolean(env.CI),
  };
  return { ...base, ...(await gitFn(cwd, env)) };
}

/** The fields every record of a run shares. */
function runFields(run) {
  const { runId, runner, group, loadAvgStart, cpus: cpuCount, ci, gitSha, dirty, branch, mainline } = run;
  return { v: SCHEMA_VERSION, runId, runner, group, gitSha, dirty, branch, mainline, loadAvgStart, cpus: cpuCount, ci };
}

/** Build a 'test' record. `ts` is when the run began (per-test start times are not portable across runners). */
export function testRecord(run, t) {
  return {
    kind: 'test',
    ...runFields(run),
    ts: run.startedAt,
    project: t.project,
    file: t.file,
    name: t.name,
    tier: t.tier,
    tierSource: t.tierSource,
    outcome: t.outcome,
    durationMs: Math.round((t.durationMs ?? 0) * 100) / 100,
    retryCount: t.retryCount ?? 0,
  };
}

/** Build the 'run' record. */
export function runRecord(run, { project, wallMs, tests, reporterMs }) {
  return { kind: 'run', ...runFields(run), ts: run.startedAt, project, wallMs: Math.round(wallMs), tests, reporterMs: Math.round(reporterMs * 100) / 100 };
}

const projectNameCache = new Map();

/** The name of the nearest `project.json` at or above `absFile` (the nx project), or the repo-relative directory. */
export function nearestProjectName(absFile, root = REPO_ROOT) {
  let dir = dirname(absFile);
  while (dir.startsWith(root) && dir !== dirname(dir)) {
    if (projectNameCache.has(dir)) return projectNameCache.get(dir);
    const pj = join(dir, 'project.json');
    if (existsSync(pj)) {
      let name = relative(root, dir) || '(root)';
      try {
        name = JSON.parse(readFileSync(pj, 'utf8')).name ?? name;
      } catch {
        // an unparsable project.json still identifies the directory
      }
      projectNameCache.set(dir, name);
      return name;
    }
    dir = dirname(dir);
  }
  return '(unknown)';
}

/** Repo-relative path when `abs` is inside `root`, else `abs`. */
export function relFile(abs, root = REPO_ROOT) {
  const r = relative(root, abs);
  return r.startsWith('..') ? abs : r;
}
