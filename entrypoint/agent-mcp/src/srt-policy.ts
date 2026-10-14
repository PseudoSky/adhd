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
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { operationalEnv, resolveLogRoots, resolveToolResultSpill, type LogRoots } from './config.js';

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
    /** External filtering proxy srt uses instead of its own (R5-WEB-SIMPLE AC2: the open-egress proxy). */
    httpProxyPort?: number;
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
  /**
   * Operator-extensible writable roots (`agent.shell.sandbox.extraAllowWrite`). Defaults to the
   * resolved config value. Validated fail-loud by {@link validateSrtExtraAllowWrite} on every
   * provision; pass `[]` to render a policy with no extra roots.
   */
  extraAllowWrite?: readonly string[];
  /**
   * Operator-declared additional trust roots under which `extraAllowWrite` entries may live
   * (`agent.shell.sandbox.extraAllowWriteRoots`). Defaults to the resolved config value.
   */
  extraAllowWriteRoots?: readonly string[];
  /**
   * Apply the sandbox write extras (`extraAllowWrite` + the managed `denyWrite` set) to THIS file.
   * Default `false`: the shared global `~/.srt-settings.json` (read by every bare `srt` the user
   * runs) never receives them (BK7 SEC-F7); only the per-run file does (`provisionRunSrtPolicy`).
   */
  applySandboxExtras?: boolean;
  /**
   * The tool-result spill directory to render as `allowRead` (BK9, `agent.toolResult.spill.*`). Only
   * applied with {@link applySandboxExtras}. Default (`undefined`): the resolved config — the dir when
   * spill is ENABLED, nothing when it is off. Pass a string to force a dir (validated fail-loud by
   * {@link validateSrtSpillReadDir}) or `null` to render none. Read access only: never added to `allowWrite`.
   */
  spillReadDir?: string | null;
  /**
   * The agent-mcp temp root an explicit {@link spillReadDir} is validated against (its `<temp>/tool-results`
   * subtree is the only agent-mcp location a spill read allow may name). Defaults to the live resolved temp
   * root; tests running under a fake `$HOME` pass theirs. Ignored when `spillReadDir` is omitted.
   */
  spillTempRoot?: string;
  /** Extra network allow-list domains to union into `allowedDomains`. Non-empty => egress is restricted. */
  allowedDomains?: string[];
  /**
   * R5-WEB-SIMPLE AC2: loopback port of the allow-all egress proxy ({@link startOpenEgressProxy}).
   * Rendered as `network.httpProxyPort` ONLY when no operator restriction applies (see
   * {@link operatorRestrictsEgress}); otherwise srt's own domain filter stays in force.
   */
  openEgressProxyPort?: number;
  /**
   * Extra paths to union into `denyWrite` (additive, NOT host-managed: later provisions of the same
   * file keep them). Used for the exit-status shim directory (61358b6f), which the sandboxed shell
   * must be able to execute but never modify.
   */
  denyWrite?: string[];
}

export interface ProvisionedSrtPolicy {
  path: string;
  /** True when the file did not exist and this call created it. */
  created: boolean;
  /** True when the file changed (created or a new rule was merged in). */
  updated: boolean;
  settings: SrtSettings;
  /** R5-WEB-SIMPLE AC2: `open` (allow-all loopback proxy) or `restricted` (srt domain allow-list). */
  egress: { mode: 'open'; proxyPort: number } | { mode: 'restricted'; domains: number };
}

/**
 * Domains the adopted servers need: PyPI for the pinned `uvx mcp-shell-server`
 * (ADR-0008 D7). The fs server needs NO network — it runs from the pinned
 * dependency with `node` (c9f0a791), so the npm registry is deliberately absent.
 */
export const DEFAULT_SRT_ALLOWED_DOMAINS: readonly string[] = [
  'pypi.org',
  '*.pypi.org',
  'files.pythonhosted.org',
];

/**
 * Credential locations the wrapped (agent-reachable) `fs`/`shell` servers must
 * never read (shell-policy spec S4 / AC7; compensating control C4). Home-expanded
 * at call time and UNIONED into `filesystem.denyRead` — user entries are never
 * clobbered. This is what blocks `cat ~/.npmrc` / `pnpm publish` credential reads
 * that no command-name rule can express.
 */
export function defaultSrtDenyRead(): string[] {
  const home = homedir();
  return [
    join(home, '.npmrc'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config', 'gh'),
    join(home, '.netrc'),
  ];
}

/** Static form of {@link defaultSrtDenyRead} for the host's own home directory. */
export const DEFAULT_SRT_DENY_READ: readonly string[] = defaultSrtDenyRead();

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

/**
 * Default value of `agent.shell.sandbox.extraAllowWrite` (backlog 515a2b50 / BK7): the backlog
 * store's DATA directory. `adhd-backlog` takes its store lease and opens SQLite (`-wal`/`-shm`
 * sidecars, `.sox-lease.d`) as siblings of the DB file in this directory — verified under real
 * `srt` (`srt-policy-bk7.e2e.test.ts`) — so it is the minimum write allow a legitimate backlog verb
 * needs. Deliberately NOT the whole `~/.adhd/backlog` tree: `production/config.yaml` (which can
 * repoint the host's next unsandboxed `adhd-backlog` at an attacker-chosen DB), `backups/`, `cache/`
 * and `test/` stay unwritable (SEC-F1).
 */
export const DEFAULT_SRT_EXTRA_ALLOW_WRITE: readonly string[] = ['~/.adhd/backlog/production/data'];

/** Default value of `agent.shell.sandbox.extraAllowWriteRoots`: no extra trust roots. */
export const DEFAULT_SRT_EXTRA_ALLOW_WRITE_ROOTS: readonly string[] = [];

/**
 * Backlog files the sandbox must NEVER write, emitted as `denyWrite` beside the data-dir allow
 * (srt honors a deny inside an allowed dir — proven in `srt-policy-bk7.e2e.test.ts`). `~/`-form;
 * expanded by {@link defaultSrtDenyWrite}.
 */
export const DEFAULT_SRT_BACKLOG_DENY_WRITE: readonly string[] = [
  '~/.adhd/backlog/production/config.yaml',
  '~/.adhd/backlog/production/backups',
];

/** Home-expanded {@link DEFAULT_SRT_BACKLOG_DENY_WRITE}. */
export function defaultSrtDenyWrite(home: string = homedir()): string[] {
  return DEFAULT_SRT_BACKLOG_DENY_WRITE.map((entry) => join(home, entry.slice(2)));
}

/** Thrown (fail loud) when `agent.shell.sandbox.extraAllowWrite` holds an unsafe entry. */
export class SrtPolicyConfigError extends Error {
  constructor(entry: unknown, reason: string, key = 'agent.shell.sandbox.extraAllowWrite') {
    super(`${key}: invalid entry ${JSON.stringify(entry)}: ${reason}`);
    this.name = 'SrtPolicyConfigError';
  }
}

/**
 * Resolve `p` through symlinks: `realpath` of the LONGEST EXISTING prefix plus the (not yet
 * existing) remainder. Pure of side effects; never throws for a missing leaf.
 */
export function resolveRealPrefix(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Comparison form of a path (SEC-F5): symlinks resolved, Unicode NFC-normalized, case-folded. The
 * fold is applied on every platform (conservative: macOS/Windows volumes are case-insensitive, so
 * `~/.SSH` IS `~/.ssh`; on Linux an over-rejection of a case variant is harmless).
 */
export function foldPath(p: string): string {
  return resolveRealPrefix(p).normalize('NFC').toLowerCase();
}

/** True when `parent` equals `child` or is a path-ancestor of it (both already folded). */
function isSameOrAncestor(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Home-relative locations the sandbox write allow may never touch, equal to, inside, or containing. */
const PROTECTED_HOME_RELATIVE: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.claude',
  '.config',
  '.npmrc',
  '.netrc',
  '.gitconfig',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.srt-settings.json',
  '.adhd/agent-mcp',
  '.adhd/tmp',
  '.adhd/sox-ecosystem',
  '.adhd/backlog/production/config.yaml',
  '.adhd/backlog/production/backups',
  'Library/LaunchAgents',
];

/** Extra inputs to {@link validateSrtExtraAllowWrite}. */
export interface ValidateSrtExtraAllowWriteOptions {
  /** Operator-declared trust roots (validated like entries, then used as additional allowlist roots). */
  readonly extraRoots?: readonly string[];
  /** Additional absolute paths that are protected (e.g. the resolved run-policy dir, the srt settings file). */
  readonly protectedPaths?: readonly string[];
}

/** Comparison form of `~/.adhd`, the root no operator trust root may be or contain. */
function adhdHomeFold(home: string): string {
  return foldPath(join(home, '.adhd'));
}

function expandHome(entry: string, home: string, key: string): string {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new SrtPolicyConfigError(entry, 'must be a non-empty string', key);
  }
  if (entry.includes('\0')) throw new SrtPolicyConfigError(entry, 'NUL bytes are not allowed', key);
  if (/[*?[\]{}]/.test(entry)) throw new SrtPolicyConfigError(entry, 'glob/wildcard characters are not allowed', key);
  if (entry.split(/[\\/]/).includes('..')) throw new SrtPolicyConfigError(entry, "'..' segments are not allowed", key);
  let expanded = entry;
  if (entry === '~') expanded = home;
  else if (entry.startsWith('~/')) expanded = join(home, entry.slice(2));
  else if (entry.startsWith('~')) throw new SrtPolicyConfigError(entry, "only a leading '~/' is expanded", key);
  if (!isAbsolute(expanded)) throw new SrtPolicyConfigError(entry, 'must be absolute (or start with ~/)', key);
  return expanded;
}

/**
 * Validate + expand `agent.shell.sandbox.extraAllowWrite` entries — an ALLOWLIST by construction
 * (architect verdict Q5 amended by the BK7 security review SEC-F4/F5). Fail loud with
 * {@link SrtPolicyConfigError}; never silently drops an entry. Every entry, after `~/` expansion,
 * must:
 *  - be absolute with no `..` segment, NUL byte, or glob metacharacter;
 *  - resolve (symlinks followed, NFC + case-folded for comparison) to a STRICT descendant of
 *    `~/.adhd/backlog`, or of (or equal to) an operator-declared trust root from
 *    `agent.shell.sandbox.extraAllowWriteRoots`; an unrelated location is refused, not "allowed
 *    unless listed";
 *  - not equal, contain, or sit inside any protected location: `$HOME` and its ancestors, `~/.ssh`,
 *    `~/.aws`, `~/.gnupg`, `~/.claude`, `~/.config`, shell rc files, `~/Library/LaunchAgents`,
 *    `~/.srt-settings.json`, `~/.adhd/agent-mcp`, `~/.adhd/tmp` (the run-policy dir), the backlog
 *    `config.yaml`/`backups`, the caller's `protectedPaths`, and every `denyRead` path.
 * Operator trust roots are validated the same way and may not be (or contain) `~/.adhd`.
 *
 * @param entries raw configured entries (`~` allowed).
 * @param home the home directory (injectable for tests; defaults to `os.homedir()` at call time).
 * @param denyRead the credential deny list (defaults to {@link defaultSrtDenyRead}).
 * @param opts extra trust roots and protected paths.
 * @returns the symlink-resolved, normalized, de-duplicated absolute paths (the ones srt will enforce).
 */
export function validateSrtExtraAllowWrite(
  entries: readonly string[],
  home: string = homedir(),
  denyRead: readonly string[] = defaultSrtDenyRead(),
  opts: ValidateSrtExtraAllowWriteOptions = {}
): string[] {
  const homeFold = foldPath(home);
  const adhdFold = adhdHomeFold(home);
  const protectedFolds = [
    ...PROTECTED_HOME_RELATIVE.map((rel) => foldPath(join(home, rel))),
    ...(opts.protectedPaths ?? []).map((p) => foldPath(p)),
    ...denyRead.map((p) => foldPath(p)),
  ];
  const check = (entry: string, key: string): { real: string; fold: string } => {
    const expanded = expandHome(entry, home, key);
    const real = resolveRealPrefix(expanded);
    const fold = foldPath(expanded);
    if (!fold.startsWith(homeFold + sep) || fold === homeFold) {
      throw new SrtPolicyConfigError(entry, `must be strictly under the home directory (${home})`, key);
    }
    for (const prot of protectedFolds) {
      if (isSameOrAncestor(fold, prot) || isSameOrAncestor(prot, fold)) {
        throw new SrtPolicyConfigError(entry, `must not be, contain, or sit inside the protected path ${prot}`, key);
      }
    }
    return { real, fold };
  };

  const backlogFold = foldPath(join(home, '.adhd', 'backlog'));
  const trustRoots: { fold: string; strict: boolean }[] = [{ fold: backlogFold, strict: true }];
  for (const root of opts.extraRoots ?? []) {
    const { fold } = check(root, 'agent.shell.sandbox.extraAllowWriteRoots');
    if (isSameOrAncestor(adhdFold, fold) || isSameOrAncestor(fold, adhdFold)) {
      throw new SrtPolicyConfigError(root, 'a trust root may not be (or contain) ~/.adhd', 'agent.shell.sandbox.extraAllowWriteRoots');
    }
    trustRoots.push({ fold, strict: false });
  }

  const out: string[] = [];
  for (const entry of entries) {
    const { real, fold } = check(entry, 'agent.shell.sandbox.extraAllowWrite');
    const allowed = trustRoots.some((r) => (r.strict ? fold !== r.fold && isSameOrAncestor(r.fold, fold) : isSameOrAncestor(r.fold, fold)));
    if (!allowed) {
      throw new SrtPolicyConfigError(
        entry,
        'must be inside ~/.adhd/backlog (e.g. ~/.adhd/backlog/production/data) or inside a root declared in ' +
          'agent.shell.sandbox.extraAllowWriteRoots'
      );
    }
    out.push(real);
  }
  return [...new Set(out)];
}

/**
 * The configured `agent.shell.sandbox.extraAllowWrite`, validated + expanded. Read from
 * {@link operationalEnv} (scope-forced `global`): a project-scope `config.yaml` under
 * `ADHD_ENV_SCOPE=project` can NEVER widen the sandbox (SEC-F3). The run-policy dir and the srt
 * settings file are protected from being allowed.
 */
export function resolveSrtExtraAllowWrite(
  configured: readonly string[] | undefined = operationalEnv.config.agent.shell.sandbox.extraAllowWrite,
  roots: readonly string[] | undefined = operationalEnv.config.agent.shell.sandbox.extraAllowWriteRoots
): string[] {
  return validateSrtExtraAllowWrite(configured ?? DEFAULT_SRT_EXTRA_ALLOW_WRITE, homedir(), defaultSrtDenyRead(), {
    extraRoots: roots ?? DEFAULT_SRT_EXTRA_ALLOW_WRITE_ROOTS,
    protectedPaths: [srtRunPolicyDir(), resolveSrtSettingsPath()],
  });
}

/** Extra inputs to {@link validateSrtSpillReadDir}. */
export interface ValidateSrtSpillReadDirOptions {
  /** The resolved agent-mcp namespaced temp root; the default spill subtree `<tempRoot>/tool-results` is derived from it. */
  readonly tempRoot?: string;
  /** Additional absolute paths that are protected (e.g. the resolved run-policy dir, the srt settings file). */
  readonly protectedPaths?: readonly string[];
  /** Operator-declared trust roots (`agent.shell.sandbox.extraAllowWriteRoots`), validated as in the BK7 validator. */
  readonly trustRoots?: readonly string[];
}

/**
 * Validate the directory rendered as `filesystem.allowRead` for the tool-result spill (BK9). A read
 * allow is narrower than a write allow, but `allowRead` re-opens paths inside a `denyRead` region, so
 * this is an ALLOWLIST by construction (9ed453c1 HARD-H3), not a denylist with a blanket exemption. After
 * `~/` expansion and symlink resolution the directory must be exactly one of:
 *  - the agent-mcp tool-result spill subtree: `<tempRoot>/tool-results` itself or a descendant of it
 *    (`tempRoot` is resolved, then `tool-results` appended, so a `tool-results` symlink pointing at the
 *    data dir resolves OUTSIDE the subtree and is refused); or
 *  - inside (or equal to) an operator-declared trust root from `agent.shell.sandbox.extraAllowWriteRoots`
 *    (each strictly under `$HOME`, never protected, never `~/.adhd` or containing it).
 * Anything else under `~/.adhd/agent-mcp` (the data dir holding the agent DB, logs, the temp root itself
 * with its credential-bearing scratch, the run-policy dir) and every other location is refused. In all
 * cases the dir may not be, contain, or sit inside a credential location, the srt settings file, a
 * `denyRead` path, or `$HOME`. Fail loud with {@link SrtPolicyConfigError}.
 *
 * @param dir the configured spill directory (absolute; `~/` allowed).
 * @param home the home directory (injectable for tests).
 * @param denyRead the credential deny list.
 * @param opts `tempRoot`, extra `protectedPaths`, and operator `trustRoots`.
 * @returns the symlink-resolved absolute path srt will enforce.
 */
export function validateSrtSpillReadDir(
  dir: string,
  home: string = homedir(),
  denyRead: readonly string[] = defaultSrtDenyRead(),
  opts: ValidateSrtSpillReadDirOptions = {}
): string {
  const key = 'agent.toolResult.spill.dir';
  const rootsKey = 'agent.shell.sandbox.extraAllowWriteRoots';
  const expanded = expandHome(dir, home, key);
  const real = resolveRealPrefix(expanded);
  const fold = foldPath(expanded);
  const homeFold = foldPath(home);
  const adhdFold = adhdHomeFold(home);

  const spillSubtree = opts.tempRoot === undefined ? undefined : join(foldPath(opts.tempRoot), 'tool-results');
  const inSpillSubtree = spillSubtree !== undefined && isSameOrAncestor(spillSubtree, fold);

  // Credential locations: the spill dir may not be, contain, or sit inside them. The agent-mcp home
  // subtree (`.adhd/agent-mcp`) is a protected location EXCEPT for the allowlisted spill subtree above.
  const protectedHome = PROTECTED_HOME_RELATIVE.filter((rel) => !(inSpillSubtree && rel === '.adhd/agent-mcp'));
  const protectedFolds = [
    ...protectedHome.map((rel) => foldPath(join(home, rel))),
    ...denyRead.map((p) => foldPath(p)),
    ...(opts.protectedPaths ?? []).map((p) => foldPath(p)),
  ];
  for (const prot of protectedFolds) {
    if (isSameOrAncestor(fold, prot) || isSameOrAncestor(prot, fold)) {
      throw new SrtPolicyConfigError(dir, `must not be, contain, or sit inside the protected path ${prot}`, key);
    }
  }
  if (isSameOrAncestor(fold, homeFold)) {
    throw new SrtPolicyConfigError(dir, 'must not be (or contain) the home directory', key);
  }

  if (inSpillSubtree) return real;

  for (const root of opts.trustRoots ?? []) {
    const rootExpanded = expandHome(root, home, rootsKey);
    const rootFold = foldPath(rootExpanded);
    if (!rootFold.startsWith(homeFold + sep)) {
      throw new SrtPolicyConfigError(root, `must be strictly under the home directory (${home})`, rootsKey);
    }
    if (isSameOrAncestor(adhdFold, rootFold) || isSameOrAncestor(rootFold, adhdFold)) {
      throw new SrtPolicyConfigError(root, 'a trust root may not be (or contain) ~/.adhd', rootsKey);
    }
    for (const prot of protectedFolds) {
      if (isSameOrAncestor(rootFold, prot) || isSameOrAncestor(prot, rootFold)) {
        throw new SrtPolicyConfigError(root, `must not be, contain, or sit inside the protected path ${prot}`, rootsKey);
      }
    }
    if (isSameOrAncestor(rootFold, fold)) return real;
  }
  throw new SrtPolicyConfigError(
    dir,
    'must be inside the agent-mcp tool-result spill subtree (<temp>/tool-results) or inside a root declared in ' +
      'agent.shell.sandbox.extraAllowWriteRoots (the agent-mcp data dir, logs, temp root and run-policy dir are never readable)',
    key
  );
}

/**
 * The tool-result spill directory to render as `allowRead`: `[dir]` when `agent.toolResult.spill.enabled`
 * is on (validated), `[]` when it is off (nothing is rendered, and nothing from an earlier enabled run
 * lingers — see `adhdManaged`). Read from the scope-pinned {@link operationalEnv}.
 */
export function resolveSrtSpillAllowRead(): string[] {
  const spill = resolveToolResultSpill();
  if (!spill.enabled) return [];
  return [validateSpillReadDirInContext(spill)];
}

/** {@link validateSrtSpillReadDir} bound to the live temp root, protected paths and operator trust roots. */
function validateSpillReadDirInContext(spill: { readonly dir: string }, tempRootOverride?: string): string {
  const roots = tempRootOverride === undefined ? resolveLogRoots() : { ...resolveLogRoots(), temp: tempRootOverride };
  return validateSrtSpillReadDir(spill.dir, homedir(), defaultSrtDenyRead(), {
    tempRoot: roots.temp,
    protectedPaths: [srtRunPolicyDir(roots), resolveSrtSettingsPath()],
    trustRoots: operationalEnv.config.agent.shell.sandbox.extraAllowWriteRoots ?? DEFAULT_SRT_EXTRA_ALLOW_WRITE_ROOTS,
  });
}

/**
 * Directory holding the per-run `srt` policy files (one per agent-mcp run): `<temp>/srt` under the
 * `@adhd/environment`-resolved namespaced temp root (c536ce29 / 03be90c3, S8B) — never a
 * hard-coded home path.
 *
 * @param roots the resolved log/temp roots (tests pass an isolated set).
 */
export function srtRunPolicyDir(roots: Pick<LogRoots, 'temp'> = resolveLogRoots()): string {
  return join(roots.temp, 'srt');
}

/**
 * The PER-RUN `srt` settings path (finding 535c1101 / A3-A4). When
 * `ADHD_AGENT_SRT_SETTINGS` is set it wins (the operator-pinned file). Otherwise
 * a file UNIQUE TO THIS PROCESS (`run-<pid>.json`) — a per-run policy, never the
 * shared `~/.srt-settings.json`, so a dispatcher's cwd is never persisted into
 * the global file and no two runs contend for the same path.
 */
export function resolveSrtRunSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  roots?: Pick<LogRoots, 'temp'>
): string {
  const override = env[SRT_SETTINGS_ENV];
  if (override) return override;
  return join(srtRunPolicyDir(roots), `run-${process.pid}.json`);
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

/** The open-egress proxy port the run policy was provisioned with, re-applied by every later re-provision. */
let activeOpenEgressPort: number | undefined;

/**
 * Provision the per-run `srt` policy (static allow-list + this run's cwd) and
 * make it the active path the resolver passes via `srt -s`. Idempotent;
 * concurrency-safe via {@link withSrtPolicyLock} (matters for a shared override).
 * Called ONCE at server startup — the agent-mcp child's `process.cwd()` IS the
 * dispatching cwd (D9), so one per-run file carries the right root.
 */
export function provisionRunSrtPolicy(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  roots?: Pick<LogRoots, 'temp'>,
  openEgressProxyPort?: number
): ProvisionedSrtPolicy {
  const path = resolveSrtRunSettingsPath(env, roots);
  const override = Boolean(env[SRT_SETTINGS_ENV]);
  // A per-run file WE own (`run-<pid>.json`, never an operator override) is rebuilt from scratch so a
  // stale file left by a recycled pid can never carry an earlier, broader allow into this run.
  if (!override) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  }
  const result = provisionSrtPolicy({ settingsPath: path, allowWrite: [cwd], applySandboxExtras: true, openEgressProxyPort });
  activeOpenEgressPort = openEgressProxyPort;
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
  provisionSrtPolicy({ settingsPath: activeRunSettingsPath, allowWrite: fresh, applySandboxExtras: true, openEgressProxyPort: activeOpenEgressPort });
  for (const root of fresh) appliedRunRoots.add(root);
}

/**
 * Make the exit-status shim directory (61358b6f) READABLE and EXECUTABLE but never WRITABLE inside the
 * ACTIVE per-run `srt` policy: `allowRead` (so it stays reachable even under a `denyRead` region) and
 * `denyWrite` (which `srt` honors even inside an `allowWrite` root, e.g. the temp dir), so the model
 * cannot plant a launcher that every later command would run. Additive, idempotent, lock-guarded; a
 * no-op when no per-run policy is active (bare `srt` / sandbox off).
 */
export function addRunSrtReadOnlyDir(dir: string): void {
  if (!activeRunSettingsPath) return;
  const key = `ro:${dir}`;
  if (appliedRunRoots.has(key)) return;
  provisionSrtPolicy({ settingsPath: activeRunSettingsPath, allowRead: [dir], denyWrite: [dir], applySandboxExtras: true, openEgressProxyPort: activeOpenEgressPort });
  appliedRunRoots.add(key);
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
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
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

interface IManaged {
  extraAllowWrite: string[];
  denyWrite: string[];
  /** Spill read-allows (BK9) injected by the previous provision. */
  allowRead: string[];
  /** The open-egress proxy port (R5-WEB-SIMPLE AC2) this host injected on the previous provision. */
  httpProxyPort: number | undefined;
}

/** The host-managed entries recorded by the previous provision (see `adhdManaged`). */
function readManaged(current: SrtSettings): IManaged {
  const raw = current['adhdManaged'];
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const port = obj['httpProxyPort'];
  return {
    extraAllowWrite: toArray(obj['extraAllowWrite']),
    denyWrite: toArray(obj['denyWrite']),
    allowRead: toArray(obj['allowRead']),
    httpProxyPort: typeof port === 'number' ? port : undefined,
  };
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

/** Create `file` exclusively (`O_EXCL`, mode 0600), replacing a planted entry at that name; never follows a symlink. */
function writeExclusive0600(file: string, data: string): void {
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      unlinkSync(file); // removes a symlink itself, not what it points at
    }
  }
  try {
    writeSync(fd, data, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
}

/**
 * Create — or additively merge into — an `srt` policy so the wrapped builtins
 * can spawn (ADR-0008 D7; deferral `a5a2f1d4`). Every pre-existing rule is
 * preserved; the allow-lists and the default credential `denyRead` list are unioned. Writes atomically
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

    // Entries this host injected on an earlier provision (tracked under `adhdManaged`, a key srt
    // ignores) are dropped first and recomputed, so narrowing/removing the config takes effect on
    // the next provision instead of accumulating forever (SEC-F7). Operator-authored entries stay.
    const prevManaged = readManaged(current);
    const withoutManaged = (list: readonly string[], managed: readonly string[]): string[] =>
      list.filter((entry) => !managed.includes(entry));
    const managedExtra = opts.applySandboxExtras
      ? resolveSrtExtraAllowWrite(opts.extraAllowWrite, opts.extraAllowWriteRoots)
      : [];
    const managedDeny = opts.applySandboxExtras ? defaultSrtDenyWrite() : [];
    // BK9: the tool-result spill dir is READ-allowed only when spill is enabled (never in the global file).
    let managedRead: string[] = [];
    if (opts.applySandboxExtras && opts.spillReadDir !== null) {
      managedRead = opts.spillReadDir === undefined ? resolveSrtSpillAllowRead() : [validateSpillReadDirInContext({ dir: opts.spillReadDir }, opts.spillTempRoot)];
    }

    const allowWrite = union(
      withoutManaged(toArray(current.filesystem?.allowWrite), prevManaged.extraAllowWrite),
      union(defaultSrtAllowWrite(), union(managedExtra, opts.allowWrite ?? []))
    );
    const allowRead = union(
      withoutManaged(toArray(current.filesystem?.allowRead), prevManaged.allowRead),
      union(managedRead, opts.allowRead ?? [])
    );
    const configuredDomains = opts.applySandboxExtras ? [...operationalEnv.config.agent.shell.sandbox.allowedDomains] : [];
    const allowedDomains = union(
      toArray(current.network?.allowedDomains),
      union(DEFAULT_SRT_ALLOWED_DOMAINS, union(configuredDomains, opts.allowedDomains ?? []))
    );
    // R5-WEB-SIMPLE AC2: egress is OPEN (srt delegates filtering to the allow-all loopback proxy) unless
    // the operator restricted it: any domain beyond the PyPI defaults (config key, caller option, or
    // already in an operator-pinned file) or an operator-authored `httpProxyPort` keeps srt's own filter.
    const operatorProxy =
      current.network?.httpProxyPort !== undefined && current.network.httpProxyPort !== prevManaged.httpProxyPort;
    const restricted =
      opts.openEgressProxyPort === undefined ||
      operatorProxy ||
      allowedDomains.some((d) => !DEFAULT_SRT_ALLOWED_DOMAINS.includes(d));
    const proxyPort = restricted ? undefined : opts.openEgressProxyPort;
    const { httpProxyPort: priorProxyPort, ...networkRest } = current.network ?? {};
    void priorProxyPort;

    const denyRead = union(toArray(current.filesystem?.denyRead), defaultSrtDenyRead());
    const denyWrite = union(
      union(withoutManaged(toArray(current.filesystem?.denyWrite), prevManaged.denyWrite), managedDeny),
      opts.denyWrite ?? []
    );

    const next: SrtSettings = {
      ...current,
      filesystem: {
        ...(current.filesystem ?? {}),
        denyRead,
        allowRead,
        allowWrite,
        denyWrite,
      },
      network: {
        ...networkRest,
        // An operator-authored proxy port survives; a port WE injected earlier is dropped unless re-applied.
        ...(operatorProxy ? { httpProxyPort: current.network?.httpProxyPort } : {}),
        allowedDomains,
        deniedDomains: toArray(current.network?.deniedDomains),
        ...(proxyPort !== undefined ? { httpProxyPort: proxyPort } : {}),
      },
      ...(managedExtra.length > 0 || managedDeny.length > 0 || managedRead.length > 0 || proxyPort !== undefined
        ? {
            adhdManaged: {
              extraAllowWrite: managedExtra,
              denyWrite: managedDeny,
              ...(managedRead.length > 0 ? { allowRead: managedRead } : {}),
              ...(proxyPort !== undefined ? { httpProxyPort: proxyPort } : {}),
            },
          }
        : {}),
    };
    if (managedExtra.length === 0 && managedDeny.length === 0 && managedRead.length === 0 && proxyPort === undefined) delete next['adhdManaged'];

    const before = existed
      ? JSON.stringify(current)
      : '';
    const after = JSON.stringify(next);
    const updated = !existed || before !== after;

    if (updated) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      // 0600 + O_EXCL (BK7 AC7.3 / SEC-F8): the policy names credential deny paths and writable
      // roots. `wx` never opens through a pre-planted symlink or reuses a pre-planted file; a planted
      // entry at the predictable name is unlinked (the link, never its target) and the create retried.
      writeExclusive0600(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, path);
    }

    const egress: ProvisionedSrtPolicy['egress'] =
      proxyPort !== undefined ? { mode: 'open', proxyPort } : { mode: 'restricted', domains: allowedDomains.length };
    return { path, created: !existed, updated, settings: next, egress };
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
