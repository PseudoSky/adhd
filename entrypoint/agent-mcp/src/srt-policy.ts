/**
 * `srt` policy provisioning for the agent-mcp host (ADR-0008 D7 / NAT-TOOL-4).
 *
 * `resolveNativeTooling` (@adhd/agent-core-native-tooling) wraps the builtin
 * `fs` and `shell` MCP servers with `@anthropic-ai/sandbox-runtime` (`srt`) BY
 * DEFAULT. `srt` reads its policy from `~/.srt-settings.json` (or the file named
 * by the `srt -s <path>` CLI flag). With no policy on disk, `srt` falls back to
 * its built-in DEFAULT-DENY config and the wrapped servers cannot reach their
 * own caches (`~/.cache/uv`, `~/.npm`) or registries — so they FAIL TO SPAWN.
 *
 * This module is the host's fix for deferral `a5a2f1d4`: it provisions (and
 * additively merges into) an `srt` policy that lets the adopted servers
 * initialize their caches and fetch their packages, plus it makes the local
 * `srt` binary resolvable on the spawned child's `PATH`.
 *
 * PER-SPAWN cwd (finding 535c1101 / A3-A4): the dispatcher's cwd is NOT written
 * into the shared `~/.srt-settings.json` (that grew monotonically with every cwd
 * ever used). Instead {@link resolveSrtRunSettingsPath} names a content-addressed
 * PER-RUN file carrying the static allow-list plus this spawn's cwd, and the
 * resolver passes it via `srt -s` (see `NativeResolveContext.srtSettingsPath`).
 * `ADHD_AGENT_SRT_SETTINGS` overrides the run-file location. The global file is
 * still provisioned, but STATIC-ONLY, as the fallback for a bare `srt` call.
 *
 * The write is deliberately NON-DESTRUCTIVE: every existing rule is preserved
 * and only the allow-lists are unioned. A pre-existing user policy is never
 * clobbered, and re-provisioning is idempotent (byte-identical output).
 *
 * CONCURRENCY (ADR-0012): multiple processes may provision the same file at
 * once, so the read-modify-write runs under an exclusive lock and the content is
 * swapped in atomically (temp + rename). Without the lock a concurrent writer's
 * rule could be lost (the read-modify-write lost update).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path *value* override for the srt settings file (ADR-0008 D10: a path value
 * is legitimate environment configuration — not an env feature toggle).
 * Default: `~/.srt-settings.json` (where `srt` looks by default).
 */
export const SRT_SETTINGS_ENV = 'ADHD_AGENT_SRT_SETTINGS';

/** The subset of `srt`'s settings schema this host manages. */
export interface SrtSettings {
  filesystem?: {
    denyRead?: string[];
    allowRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
  };
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
  };
  /** Any other srt setting (e.g. `windows`) is carried through untouched. */
  [key: string]: unknown;
}

export interface ProvisionSrtPolicyOptions {
  /** Explicit settings path; defaults to `ADHD_AGENT_SRT_SETTINGS`/`~/.srt-settings.json`. */
  settingsPath?: string;
  /** Extra writable roots (e.g. the dispatching cwd) to union into `allowWrite`. */
  allowWrite?: string[];
  /** Extra readable roots to union into `allowRead`. */
  allowRead?: string[];
  /** Extra network allow-list domains to union into `allowedDomains`. */
  allowedDomains?: string[];
}

export interface ProvisionedSrtPolicy {
  path: string;
  /** True when the file did not exist and this call created it. */
  created: boolean;
  /** True when the file changed (created or a new rule was merged in). */
  updated: boolean;
  settings: SrtSettings;
}

/**
 * Domains the adopted servers need: PyPI for `uvx mcp-shell-server` and the
 * npm registry for `npx @modelcontextprotocol/server-filesystem` (ADR-0008 D7).
 */
export const DEFAULT_SRT_ALLOWED_DOMAINS: readonly string[] = [
  'pypi.org',
  '*.pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
];

/**
 * Writable caches the wrapped servers initialize on first run (they are
 * default-DENIED by srt's built-in config). Existing dirs only — a path that
 * does not exist is still harmless, but we keep the policy lean.
 */
export function defaultSrtAllowWrite(): string[] {
  const home = homedir();
  // UNCONDITIONAL (finding 535c1101 / A3(b)): an `existsSync` gate silently
  // DROPPED a cache root that is created lazily on first `uvx`/`npx` run — the
  // exact case that then failed under srt's default-deny. A non-existent path is
  // harmless in the policy. `~/Library/Caches` (macOS) is always included; the
  // hard-coded `/private/tmp` is dropped because `tmpdir()` already yields the
  // real per-user temp dir on every platform.
  return [
    ...new Set([
      // `uvx` unpacks/installs the tool it runs under `~/.local/share/uv/tools`,
      // NOT `~/.cache/uv`. Without this root the wrapped `uvx mcp-shell-server`
      // fails with "Could not create temporary file … Operation not permitted"
      // (surfaced by NAT-TOOL-9's live fs/shell e2e).
      join(home, '.cache', 'uv'),
      join(home, '.local', 'share', 'uv'),
      join(home, '.local', 'share'),
      join(home, '.npm'),
      join(home, '.cache'),
      join(home, 'Library', 'Caches'),
      tmpdir(),
    ]),
  ];
}

/** Directory holding the per-run `srt` policy files (one per agent-mcp run). */
export function srtRunPolicyDir(): string {
  return join(homedir(), '.adhd', 'agent-mcp', 'srt');
}

/**
 * The PER-RUN `srt` settings path (finding 535c1101 / A3-A4). When
 * `ADHD_AGENT_SRT_SETTINGS` is set it wins (the operator-pinned file). Otherwise
 * a file UNIQUE TO THIS PROCESS (`run-<pid>.json`) — a per-run policy, never the
 * shared `~/.srt-settings.json`, so a dispatcher's cwd is never persisted into
 * the global file and no two runs contend for the same path.
 */
export function resolveSrtRunSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SRT_SETTINGS_ENV];
  if (override) return override;
  return join(srtRunPolicyDir(), `run-${process.pid}.json`);
}

/** The run settings path provisioned by this process, if any. */
let activeRunSettingsPath: string | undefined;
/** True when the active path came from `ADHD_AGENT_SRT_SETTINGS` (never removed by us). */
let activeRunSettingsIsOverride = false;
/**
 * Roots already unioned into the active per-run policy — an in-memory fast path
 * so a per-TASK call ({@link addRunSrtAllowWrite}, once per resolution) does not
 * re-lock + rewrite the file for a root that is already present. Cleared
 * whenever the active path changes.
 */
const appliedRunRoots = new Set<string>();

/**
 * Provision the per-run `srt` policy (static allow-list + this run's cwd) and
 * make it the active path the resolver passes via `srt -s`. Idempotent;
 * concurrency-safe via {@link withSrtPolicyLock} (matters for a shared override).
 * Called ONCE at server startup — the agent-mcp child's `process.cwd()` IS the
 * dispatching cwd (D9), so one per-run file carries the right root.
 */
export function provisionRunSrtPolicy(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): ProvisionedSrtPolicy {
  const path = resolveSrtRunSettingsPath(env);
  const result = provisionSrtPolicy({ settingsPath: path, allowWrite: [cwd] });
  activeRunSettingsPath = path;
  activeRunSettingsIsOverride = Boolean(env[SRT_SETTINGS_ENV]);
  appliedRunRoots.clear();
  appliedRunRoots.add(cwd);
  return result;
}

/** The active per-run settings path, or `undefined` when none was provisioned. */
export function getSrtRunSettingsPath(): string | undefined {
  return activeRunSettingsPath;
}

/**
 * Union additional filesystem roots into the ACTIVE per-run `srt` policy's
 * `allowWrite` (ADR-0008 D7; finding 535c1101 / A3; MULTI-ROOT).
 *
 * `provisionRunSrtPolicy` seeds the per-run file with the dispatching cwd, but a
 * task may expose MORE than one `nativeTooling.fs` root (`FsBuiltinOverrides.roots`).
 * Without this, a read from a second root is sandbox-DENIED even though the fs
 * server itself allows it. Called at task-time resolution with the exact roots
 * the resolved fs server will expose, so every root is writable — and, because
 * `srt` derives read access from the write roots when reads are restricted,
 * READABLE too.
 *
 * Additive + idempotent (byte-identical on re-merge), concurrency-safe (the
 * read-modify-write runs under {@link withSrtPolicyLock}). A no-op when no
 * per-run policy is active (the resolver then emits a bare `srt`, or the sandbox
 * is disabled) or when there are no roots.
 */
export function addRunSrtAllowWrite(roots: readonly string[]): void {
  if (!activeRunSettingsPath) return;
  if (roots.length === 0) return;
  const fresh = roots.filter((root) => !appliedRunRoots.has(root));
  if (fresh.length === 0) return;
  provisionSrtPolicy({ settingsPath: activeRunSettingsPath, allowWrite: fresh });
  for (const root of fresh) appliedRunRoots.add(root);
}

/**
 * Forget + best-effort remove the per-run file WE created (never an operator
 * override). Call on shutdown so a run leaves no stale policy behind.
 */
export function removeRunSrtPolicy(): void {
  if (activeRunSettingsPath && !activeRunSettingsIsOverride) {
    try {
      rmSync(activeRunSettingsPath, { force: true });
    } catch {
      /* ignore */
    }
  }
  activeRunSettingsPath = undefined;
  activeRunSettingsIsOverride = false;
  appliedRunRoots.clear();
}

/** The lock file guarding a given settings path's read-modify-write. */
export function srtPolicyLockPath(settingsPath: string): string {
  return `${settingsPath}.lock`;
}

const SRT_LOCK_TIMEOUT_MS = 5_000;
const SRT_LOCK_STALE_MS = 10_000;

/** Block the calling thread for `ms` without busy-spinning. */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive lock adjacent to `settingsPath` (ADR-0012:
 * concurrent processes must not lose each other's writes). `mkdir` + `open(O_EXCL)`
 * is the atomic primitive; a stale lock older than {@link SRT_LOCK_STALE_MS} is
 * reclaimed so a crashed holder cannot wedge the file forever, and the wait is
 * bounded by {@link SRT_LOCK_TIMEOUT_MS}. The lock file is removed in `finally`.
 *
 * Exported so the concurrency proof can hold the lock from another worker and
 * assert a concurrent `provisionSrtPolicy` waits (it must NOT read a stale file).
 */
export function withSrtPolicyLock<T>(settingsPath: string, fn: () => T): T {
  const lockPath = srtPolicyLockPath(settingsPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + SRT_LOCK_TIMEOUT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > SRT_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Holder released between the failed open and the stat — retry now.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`srt policy lock timed out: ${lockPath}`);
      }
      sleepSync(2);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** The default settings path (`ADHD_AGENT_SRT_SETTINGS` wins, then `~/.srt-settings.json`). */
export function resolveSrtSettingsPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env[SRT_SETTINGS_ENV];
  if (override) return override;
  return join(homedir(), '.srt-settings.json');
}

/** True when a parseable srt settings file exists at `path`. */
export function isSrtPolicyProvisioned(path = resolveSrtSettingsPath()): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return !!parsed && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Union `extra` into `existing`, preserving order and dropping duplicates. */
function union(existing: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...existing, ...extra])];
}

function readExisting(path: string): SrtSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as SrtSettings) : {};
  } catch {
    // A corrupt file is replaced wholesale by the provisioned policy — srt
    // itself refuses to run on an invalid file, so leaving it is worse.
    return {};
  }
}

/**
 * Create — or additively merge into — an `srt` policy so the wrapped builtins
 * can spawn (ADR-0008 D7; deferral `a5a2f1d4`). Every pre-existing rule is
 * preserved; only the six allow-lists are unioned. Writes atomically
 * (temp file + rename) so a concurrent reader never sees a half-written file.
 *
 * Idempotent: calling twice with the same inputs yields byte-identical bytes.
 */
export function provisionSrtPolicy(
  opts: ProvisionSrtPolicyOptions = {}
): ProvisionedSrtPolicy {
  const path = opts.settingsPath ?? resolveSrtSettingsPath();
  // The whole read-modify-write runs under one exclusive lock so a concurrent
  // provisioner cannot lose our rule (ADR-0012; finding 535c1101).
  return withSrtPolicyLock(path, () => {
    const existed = existsSync(path);
    const current = readExisting(path);

    const allowWrite = union(
      toArray(current.filesystem?.allowWrite),
      union(defaultSrtAllowWrite(), opts.allowWrite ?? [])
    );
    const allowRead = union(toArray(current.filesystem?.allowRead), opts.allowRead ?? []);
    const allowedDomains = union(
      toArray(current.network?.allowedDomains),
      union(DEFAULT_SRT_ALLOWED_DOMAINS, opts.allowedDomains ?? [])
    );

    const next: SrtSettings = {
      ...current,
      filesystem: {
        ...(current.filesystem ?? {}),
        denyRead: toArray(current.filesystem?.denyRead),
        allowRead,
        allowWrite,
        denyWrite: toArray(current.filesystem?.denyWrite),
      },
      network: {
        ...(current.network ?? {}),
        allowedDomains,
        deniedDomains: toArray(current.network?.deniedDomains),
      },
    };

    const before = existed
      ? JSON.stringify(current)
      : '';
    const after = JSON.stringify(next);
    const updated = !existed || before !== after;

    if (updated) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, path);
    }

    return { path, created: !existed, updated, settings: next };
  });
}

/**
 * Resolve the `node_modules/.bin` directory that holds the `srt` launcher by
 * walking up from this module. Returns `undefined` when not found (a published
 * install whose bin dir is elsewhere); callers then leave `PATH` untouched.
 */
export function resolveNativeBinDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const bin = join(dir, 'node_modules', '.bin');
    if (existsSync(join(bin, 'srt')) || existsSync(join(bin, 'uvx'))) return bin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Return `pathValue` with `binDir` prepended when it is not already present, so
 * the spawned `srt`/`npx`/`uvx` children resolve their launchers. Pure. Pass an
 * explicit `undefined` for `binDir` to leave the value untouched.
 */
export function ensureBinDirOnPath(
  pathValue: string | undefined,
  binDir: string | undefined
): string | undefined {
  if (!binDir) return pathValue;
  const parts = (pathValue ?? '').split(delimiter).filter(Boolean);
  if (parts.includes(binDir)) return pathValue;
  return [binDir, ...parts].join(delimiter);
}
