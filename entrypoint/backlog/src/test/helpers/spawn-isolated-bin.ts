/**
 * spawn-isolated-bin.ts — the ONE owner of the HOME-redirect isolation
 * invariant every spawned-bin spec in this package depends on.
 *
 * WHY this exists (the invariant, in one place instead of many):
 *   A spec that spawns the REAL built `dist/index.js` as a child process must
 *   never let that child read the machine's real `~/.adhd`. Isolation is TWO
 *   redirects, and BOTH are required:
 *
 *     - `ADHD_BACKLOG_SCOPE=project` + a fresh, empty `cwd` with no ancestor
 *       `.adhd` marker (a throwaway `mkdtempSync` dir) moves the DATA root
 *       onto that temp `cwd`.
 *     - `HOME` is redirected to that same temp `cwd` so the GLOBAL config
 *       layer resolves under the temp home too. `ADHD_BACKLOG_SCOPE=project`
 *       alone does NOT isolate the global layer: `@adhd/environment`'s
 *       `resolveRoots` (`roots.ts`) reads
 *       `<homedir()>/.adhd/<project>/<namespace>/config.yaml`
 *       unconditionally, and `homedir()` honors `$HOME`. Without the HOME
 *       redirect the child reads the real machine's
 *       `~/.adhd/backlog/production/config.yaml`, whose post-cutover
 *       `db.path` pointed at the PRODUCTION store — so every run opened
 *       production and wrote test rows into it (the config-isolation leak
 *       the redirect fixes; see cli.spec.ts's `runBin` history).
 *
 *   AND the ambient ENV is a third leak the two redirects above do not close.
 *   `buildIsolatedEnv` copies the parent's whole environment, so an ambient
 *   `ADHD_ROOT`, `ADHD_BACKLOG_DATABASE_PATH`, `SOX_ECOSYSTEM_HOME`, or
 *   `APIGEN_IR_CACHE_FILE` exported into the shell running the suite would
 *   still WIN over the temp root (each is an explicit higher-precedence
 *   redirect than `HOME`/scope — see `cli.ts`'s `ADHD_ROOT` read,
 *   `env.ts`'s `ADHD_BACKLOG_DATABASE_PATH` config field, and
 *   `default-cache-file.ts`'s `APIGEN_IR_CACHE_FILE` read). The invariant
 *   therefore held only on a clean shell. Those four keys are now DELETED
 *   from the base before the pins are applied (see `AMBIENT_REDIRECT_ENV_KEYS`
 *   below) — so the isolation holds regardless of the ambient shell, while a
 *   deliberate `extraEnv` override still wins (it is applied last).
 *
 *   Every spawn site that relies on the HOME-redirect invariant routes through
 *   `buildIsolatedEnv` / `isolatedSpawnOptions` / `runIsolatedBin` below, and
 *   `spawn-isolated-bin.spec.ts` drives the invariant end-to-end so a future
 *   edit that drops a redirect — or reintroduces an ambient-env leak — fails a
 *   real test instead of silently reopening production. (Sites that isolate by
 *   a DIFFERENT, deliberate mechanism are out of scope for this helper: the
 *   `--sandbox`/`ADHD_ROOT` probe in `cli.spec.ts`'s sandbox block, the
 *   `mcp-stdio-entry.js` fixture in `server.mcp.spec.ts`, and the worker-thread
 *   store specs that pass a path as `workerData` rather than through `env`.)
 *
 * `extraEnv` layers over the base and therefore WINS over it — that is how a
 * site adds its own `ADHD_BACKLOG_DATABASE_PATH` / `SOX_ECOSYSTEM_HOME` /
 * `APIGEN_IR_CACHE_FILE` / `VITEST` / `PATH` override while still inheriting
 * the invariant.
 */
import { spawnSync } from 'node:child_process';

/**
 * Ambient env keys that, if inherited, would OVERRIDE the temp-root redirect
 * (each is read at a higher precedence than `HOME`/`ADHD_BACKLOG_SCOPE` by the
 * code under test). `buildIsolatedEnv` deletes them from the base env before
 * applying its pins, so an export in the shell running the suite cannot
 * re-point a spawned child at the real store. A site that genuinely wants one
 * of these passes it through `extraEnv`, which is applied AFTER the strip.
 */
export const AMBIENT_REDIRECT_ENV_KEYS = [
  'ADHD_ROOT',
  'ADHD_BACKLOG_DATABASE_PATH',
  'SOX_ECOSYSTEM_HOME',
  'APIGEN_IR_CACHE_FILE',
] as const;

/** The shape every spawn site here consumes — mirrors `spawnSync`'s fields. */
export interface IsolatedSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface IsolatedRunOptions {
  /**
   * Extra env vars layered over the base; a key here WINS over the base
   * (including over `ADHD_BACKLOG_SCOPE`/`HOME` and over the ambient-env
   * strip).
   */
  extraEnv?: Record<string, string>;
  /**
   * Child-process timeout in ms. Defaults to 60_000 — the built bin's
   * extraction dominates a cold run, so the older 30_000 default had little
   * headroom under load.
   */
  timeoutMs?: number;
}

/**
 * Builds the isolated child env: a copy of the parent's environment with
 * `AMBIENT_REDIRECT_ENV_KEYS` removed, then `ADHD_BACKLOG_SCOPE=project`, then
 * `HOME=<root>`, then `extraEnv` last.
 * Returns `Record<string, string>` so it drops straight into `spawnSync`'s
 * `env` AND `@modelcontextprotocol/sdk`'s `StdioClientTransport` `env`.
 */
export function buildIsolatedEnv(
  root: string,
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((AMBIENT_REDIRECT_ENV_KEYS as readonly string[]).includes(key)) continue;
    base[key] = value;
  }
  return { ...base, ADHD_BACKLOG_SCOPE: 'project', HOME: root, ...extraEnv };
}

/**
 * The `{ cwd, env }` pair every isolated spawn site needs — spread it into a
 * `spawnSync`/`spawn` options object, or into a `StdioClientTransport`
 * (`{ command, args, ...isolatedSpawnOptions(root) }`).
 */
export function isolatedSpawnOptions(
  root: string,
  extraEnv: Record<string, string> = {}
): { cwd: string; env: Record<string, string> } {
  return { cwd: root, env: buildIsolatedEnv(root, extraEnv) };
}

/**
 * Spawns `binPath` as a genuine child process (`process.execPath binPath …`)
 * under the isolated env, returning `spawnSync`'s result shape. Throws on a
 * spawn error (a missing/unloadable bin must be loud, never a silent
 * `status: null`), with a timeout called out explicitly so a too-short
 * `timeoutMs` is distinguishable from a genuine spawn failure.
 */
export function runIsolatedBin(
  binPath: string,
  args: string[],
  root: string,
  options: IsolatedRunOptions = {}
): IsolatedSpawnResult {
  const { extraEnv, timeoutMs = 60_000 } = options;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    ...isolatedSpawnOptions(root, extraEnv),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const kind =
      code === 'ETIMEDOUT'
        ? `timed out after ${timeoutMs}ms (raise timeoutMs if the bin legitimately needs longer)`
        : `spawn error${code ? ` (${code})` : ''}`;
    throw new Error(
      `spawn ${kind} for ${binPath} ${JSON.stringify(
        args
      )} (cwd=${root}): ${String(result.error)}`
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
