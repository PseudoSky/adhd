/**
 * Shell exit-status shim (backlog 61358b6f).
 *
 * The adopted `tumf/mcp-shell-server==1.1.12` computes each command's exit
 * status but never reports it: a non-zero exit returns `isError:false` with
 * whatever the command printed (often `content: []`). The owner constraint is
 * that the server is neither forked nor patched, so the status is recovered the
 * only way an unmodified server allows: the server spawns allowlisted commands
 * by NAME with the `PATH` of its own process (`process_manager.py`), so a
 * launcher directory placed FIRST on that `PATH` sees every spawn, runs the real
 * binary, and — on a non-zero exit — appends one line to stderr:
 *
 *     [exit status: N]
 *
 * The server returns stderr as an ordinary text content part, so the line
 * reaches the model unchanged, and the engine parses it into a structured
 * `exitStatus` (the engine owns a mirrored copy of {@link SHELL_EXIT_SENTINEL_RE};
 * a contract test pins the two together).
 *
 * The shim is inert for anything the server refuses (it never reaches `exec`),
 * so the allowlist remains enforced by the server alone. It only wraps names
 * found on the ORIGINAL `PATH`; an allowlist entry that is an absolute path
 * (`/bin/ls`) bypasses PATH lookup and therefore the shim (documented gap).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';

/** Env var carrying the original (un-shimmed) `PATH` to the launcher. */
export const EXIT_SHIM_ORIG_PATH_ENV = 'ADHD_SHIM_ORIG_PATH';

/**
 * The exit-status sentinel the launcher writes and the engine reads: a whole
 * `[exit status: N]` line (N a non-negative integer) at the END of a text part.
 * The engine's `SHELL_EXIT_SENTINEL_RE` is the same expression (pinned equal by a
 * contract test in agent-mcp).
 */
export const SHELL_EXIT_SENTINEL_RE = /(?:^|\n)\[exit status: (\d{1,3})\]\s*$/;

/** Builds the sentinel line for status `n` (single producer of the text). */
export function formatExitSentinel(n: number): string {
  return `[exit status: ${n}]`;
}

/**
 * Executable names that are NEVER shimmed. The shell server process (and `uvx`,
 * which locates python through `PATH`) inherits the same `PATH`, so shadowing a
 * runtime name would wrap the server's own toolchain; `srt` locates its sandbox
 * helpers (`sandbox-exec`, `bwrap`, `socat`) by name too. Entries ending in `*`
 * are prefixes.
 */
export const EXIT_SHIM_PROTECTED: readonly string[] = Object.freeze([
  'uv',
  'uvx',
  'python*',
  'srt',
  'node',
  'sh',
  'env',
  'bash',
  'zsh',
  'dash',
  'which',
  'sandbox-exec',
  'bwrap',
  'socat',
]);

/** True when `name` must not be shimmed. */
export function isExitShimProtected(name: string): boolean {
  return EXIT_SHIM_PROTECTED.some((p) =>
    p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p
  );
}

/**
 * The launcher (POSIX `sh`, shebang `/bin/sh`, no `PATH` dependency). Each shim
 * entry is a symlink to this file; `$0` is the symlink path, so the basename is
 * the command name. It resolves the real binary from `ADHD_SHIM_ORIG_PATH`
 * (skipping its own directory), runs it as a child with stdin explicitly
 * inherited, forwards `TERM`/`INT`/`HUP` (the server terminates timed-out
 * commands with SIGTERM), and prints the sentinel only on a non-zero exit.
 */
export const LAUNCHER_SOURCE = `#!/bin/sh
name=\${0##*/}
shim_dir=\${0%/*}
orig=\${${EXIT_SHIM_ORIG_PATH_ENV}-}
real=
oldifs=$IFS
IFS=:
for d in $orig; do
  [ -n "$d" ] || continue
  [ "$d" = "$shim_dir" ] && continue
  if [ -x "$d/$name" ] && [ ! -d "$d/$name" ]; then
    real="$d/$name"
    break
  fi
done
IFS=$oldifs
if [ -z "$real" ]; then
  echo "$name: command not found" >&2
  echo "${formatExitSentinel(127)}" >&2
  exit 127
fi
PATH=$orig
export PATH
"$real" "$@" <&0 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM
trap 'kill -INT "$pid" 2>/dev/null' INT
trap 'kill -HUP "$pid" 2>/dev/null' HUP
while :; do
  wait "$pid"
  rc=$?
  kill -0 "$pid" 2>/dev/null || break
done
if [ "$rc" -ne 0 ]; then
  printf '[exit status: %s]\\n' "$rc" >&2
fi
exit "$rc"
`;

/** Result of {@link prepareExitShimDir}. */
export interface ExitShimDir {
  /** Absolute launcher directory; goes FIRST on the server's `PATH`. */
  dir: string;
  /** The original `PATH`, to be exposed to the launcher as `ADHD_SHIM_ORIG_PATH`. */
  origPath: string;
}

const SAFE_NAME = /^[A-Za-z0-9._+@-]+$/;

function listExecutables(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Create (idempotently) the read-only launcher directory for `origPath` under
 * `rootDir` and return it. The directory is keyed by a hash of the launcher
 * source and `origPath`, populated in a private sibling and `rename`d into place
 * (concurrent processes, ADR-0012: a loser of the rename reuses the winner's
 * directory), and left mode 0555. The directory MUST live outside every
 * sandbox-writable root; the host also adds it to the sandbox `denyWrite`.
 */
export function prepareExitShimDir(opts: {
  origPath: string;
  rootDir: string;
}): ExitShimDir {
  const origPath = opts.origPath;
  const key = createHash('sha256')
    .update(LAUNCHER_SOURCE)
    .update('\0')
    .update(origPath)
    .digest('hex')
    .slice(0, 16);
  const rootDir = resolve(opts.rootDir);
  const dir = join(rootDir, key);
  if (existsSync(join(dir, '.launcher'))) return { dir, origPath };

  mkdirSync(rootDir, { recursive: true });
  const staging = mkdtempSync(join(rootDir, `.staging-${key}-`));
  try {
    const launcher = join(staging, '.launcher');
    writeFileSync(launcher, LAUNCHER_SOURCE, { mode: 0o555 });
    chmodSync(launcher, 0o555);
    const seen = new Set<string>();
    for (const entry of origPath.split(delimiter)) {
      if (!entry) continue;
      for (const name of listExecutables(entry)) {
        if (seen.has(name) || !SAFE_NAME.test(name) || name.startsWith('.')) continue;
        if (isExitShimProtected(name)) continue;
        if (!isExecutableFile(join(entry, name))) continue;
        seen.add(name);
        symlinkSync('.launcher', join(staging, name));
      }
    }
    try {
      // A directory rename needs write permission on the directory itself (its
      // `..` entry is rewritten), so seal it AFTER it is in place.
      renameSync(staging, dir);
      chmodSync(dir, 0o555);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        if (!existsSync(join(dir, '.launcher'))) throw err;
        // Another process won the race; reuse its directory and drop ours.
        rmSync(staging, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
  return { dir, origPath };
}
