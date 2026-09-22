/**
 * spawn-isolated-bin.ts — the ONE owner of the HOME-redirect isolation
 * invariant every spawned-bin spec in this package depends on.
 *
 * WHY this exists (the invariant, in one place instead of 15):
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
 *   Before this helper the invariant was copy-pasted at 15 spawn sites across
 *   10 spec files with no shared guard (PR #10 review finding `82470ae8`,
 *   MEDIUM/durability). Every site now routes through `buildIsolatedEnv` /
 *   `isolatedSpawnOptions` / `runIsolatedBin` below, and
 *   `spawn-isolated-bin.spec.ts` drives the invariant end-to-end so a future
 *   edit that drops a redirect fails a real test instead of silently
 *   reopening production.
 *
 * `extraEnv` layers over the base and therefore WINS over it — that is how a
 * site adds its own `ADHD_BACKLOG_DATABASE_PATH` / `SOX_ECOSYSTEM_HOME` /
 * `VITEST` / `PATH` override while still inheriting the invariant.
 */
import { spawnSync } from 'node:child_process';

/** The shape every spawn site here consumes — mirrors `spawnSync`'s fields. */
export interface IsolatedSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface IsolatedRunOptions {
  /**
   * Extra env vars layered over the base; a key here WINS over the base
   * (including over `ADHD_BACKLOG_SCOPE`/`HOME`).
   */
  extraEnv?: Record<string, string>;
  /** Child-process timeout in ms. Defaults to 30_000 — the sites' common value. */
  timeoutMs?: number;
}

/**
 * Builds the isolated child env: a copy of the parent's environment, then
 * `ADHD_BACKLOG_SCOPE=project`, then `HOME=<root>`, then `extraEnv` last.
 * Returns `Record<string, string>` so it drops straight into `spawnSync`'s
 * `env` AND `@modelcontextprotocol/sdk`'s `StdioClientTransport` `env`.
 */
export function buildIsolatedEnv(
  root: string,
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
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
 * `status: null`).
 */
export function runIsolatedBin(
  binPath: string,
  args: string[],
  root: string,
  options: IsolatedRunOptions = {}
): IsolatedSpawnResult {
  const { extraEnv, timeoutMs = 30_000 } = options;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    ...isolatedSpawnOptions(root, extraEnv),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) {
    throw new Error(
      `spawn failed for ${binPath} ${JSON.stringify(args)}: ${String(
        result.error
      )}`
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
