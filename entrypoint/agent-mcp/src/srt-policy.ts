/**
 * `srt` policy provisioning for the agent-mcp host (ADR-0008 D7 / NAT-TOOL-4).
 *
 * `resolveNativeTooling` (@adhd/agent-core-native-tooling) wraps the builtin
 * `fs` and `shell` MCP servers with `@anthropic-ai/sandbox-runtime` (`srt`) BY
 * DEFAULT. `srt` reads its policy from `~/.srt-settings.json` (there is no
 * settings-path env var — only the `srt -s <path>` CLI flag, which the resolver
 * does not emit). With no policy on disk, `srt` falls back to its built-in
 * DEFAULT-DENY config and the wrapped servers cannot reach their own caches
 * (`~/.cache/uv`, `~/.npm`) or registries — so they FAIL TO SPAWN.
 *
 * This module is the host's fix for deferral `a5a2f1d4`: it provisions (and
 * additively merges into) an `srt` policy that lets the adopted servers
 * initialize their caches and fetch their packages, plus it makes the local
 * `srt` binary resolvable on the spawned child's `PATH`.
 *
 * The write is deliberately NON-DESTRUCTIVE: every existing rule is preserved
 * and only the allow-lists are unioned. A pre-existing user policy is never
 * clobbered, and re-provisioning is idempotent (byte-identical output).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  const candidates = [
    join(homedir(), '.cache', 'uv'),
    join(homedir(), '.npm'),
    join(homedir(), '.cache'),
    tmpdir(),
    '/private/tmp',
  ];
  return [...new Set(candidates.filter((p) => p && existsSync(p)))];
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
