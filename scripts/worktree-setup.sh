#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# worktree-setup.sh — hash-gated dependency provisioning for git worktrees
#
# Implements the hash gate specified in
#   docs/contributing/conventions/worktree-workflow.md  §3.1.3
#
#   Usage:
#     scripts/worktree-setup.sh [<worktree-path>] [options]
#
#   Arguments:
#     <worktree-path>   Git worktree to provision. Defaults to the current
#                       directory. The path may be given before or after any
#                       option.
#
#   Options:
#     --reuse           Provision by reusing the main checkout's node_modules
#                       (clone / hardlink / copy — see --clone/--hardlink/--copy)
#                       instead of invoking pnpm. §3.1.3's filesystem path.
#     --clone           Reuse via an APFS copy-on-write clone (cp -cR). Isolated,
#                       but slow here — see the note below.
#     --hardlink        Reuse via hardlinks (cp -al). Fastest reuse; shares file
#                       inodes with the main checkout.
#     --copy            Reuse via a deep copy (cp -a). Fully isolated, slowest.
#     --force, -f       Ignore the recorded hash stamp and re-provision.
#     --quiet, -q       Suppress non-error output.
#     --help, -h        Print this help and exit 0.
#
#   What it does (the hash gate, §3.1.3):
#     1. Hash the target worktree's package.json + pnpm-lock.yaml.
#     2. If the worktree is already provisioned for that hash — pnpm's own
#        node_modules/.modules.yaml exists AND our stamp matches — that is a
#        fast no-op. Nothing is installed. (This is the path that delivers the
#        "0 consumed time for unchanged deps" goal in practice.)
#     3. Otherwise provision it, then stamp the hash.
#
#   MEASURED CORRECTION TO §3.1.3 (2026-09-25, this repo):
#   §3.1.3 assumed reusing a built node_modules by filesystem copy/link is
#   cheaper than invoking pnpm. That is FALSE on this repo. node_modules is a
#   hoisted layout (§.npmrc node-linker=hoisted) of 163,538 files / 3.2 GB, so
#   any full-tree clone/hardlink pays one syscall per file: measured >120s
#   (killed), vs. a warm-store `pnpm install --frozen-lockfile` at 55.8s.
#   The script therefore DEFAULTS to pnpm and keeps the §3.1.3 reuse path
#   behind `--reuse` (+ `--clone`/`--hardlink`/`--copy`) for explicit use
#   (offline, no-pnpm, or when a tree is small). See the doc's Status note.
#
#   Safety (per AGENTS.md):
#     * Never runs `rm -rf`, `git stash`, `git reset --hard`, or `git clean`.
#     * A partial/corrupt node_modules (present but without .modules.yaml) is
#       quarantined by *moving* it under the worktree's canonical ephemeral
#       root (tmp/), never deleted — recoverable by the operator.
#     * A per-target lock prevents two concurrent runs from clobbering the same
#       worktree; a stale lock (dead pid) is reclaimed automatically.
#
#   Exit codes:
#     0  provisioned, or already provisioned (no-op)
#     1  usage / bad arguments
#     2  environment error (not a git worktree, missing package.json, no pnpm)
#     3  another run holds the lock
#     4  reuse from the main checkout failed (or was requested but impossible)
#     5  `pnpm install --frozen-lockfile` failed
#     6  post-provision verification failed
# ---------------------------------------------------------------------------
set -euo pipefail

# --- argument parsing ------------------------------------------------------

TARGET_ARG=""
REUSE=0
MODE=""          # "", "clone", "hardlink", "copy"
FORCE=0
QUIET=0
LOCK_DIR=""

usage() {
  printf '%s\n' \
    "Usage: scripts/worktree-setup.sh [<worktree-path>] [options]" \
    "" \
    "  <worktree-path>   Git worktree to provision (default: current directory)." \
    "" \
    "  --reuse           Reuse the main checkout's node_modules instead of pnpm." \
    "  --clone           Reuse via APFS clone (cp -cR)." \
    "  --hardlink        Reuse via hardlinks (cp -al)." \
    "  --copy            Reuse via a deep copy (cp -a)." \
    "  --force, -f       Ignore the recorded hash stamp and re-provision." \
    "  --quiet, -q       Suppress non-error output." \
    "  --help, -h        Print this help and exit 0."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reuse)    REUSE=1; shift ;;
    --clone)    REUSE=1; MODE="clone"; shift ;;
    --hardlink) REUSE=1; MODE="hardlink"; shift ;;
    --copy)     REUSE=1; MODE="copy"; shift ;;
    --force|-f) FORCE=1; shift ;;
    --quiet|-q) QUIET=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    -*)         usage >&2; printf '[worktree-setup] ERROR: unknown option: %s\n' "$1" >&2; exit 1 ;;
    *)
      if [ -z "$TARGET_ARG" ]; then
        TARGET_ARG="$1"
      else
        usage >&2
        printf '[worktree-setup] ERROR: unexpected extra argument: %s\n' "$1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

log()  { [ "$QUIET" = 1 ] || printf '[worktree-setup] %s\n' "$*"; }
warn() { printf '[worktree-setup] WARN: %s\n' "$*" >&2; }
die()  { local code="$1"; shift; printf '[worktree-setup] ERROR: %s\n' "$*" >&2; exit "$code"; }

# --- resolve target + main checkout ----------------------------------------

if [ -n "$TARGET_ARG" ]; then
  [ -d "$TARGET_ARG" ] || die 2 "target path does not exist or is not a directory: $TARGET_ARG"
  TARGET_ROOT="$(cd "$TARGET_ARG" && pwd -P)"
else
  TARGET_ROOT="$(pwd -P)"
fi

git -C "$TARGET_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die 2 "not inside a git work tree: $TARGET_ROOT"

TARGET_ROOT="$(git -C "$TARGET_ROOT" rev-parse --show-toplevel)"

# The main checkout is the parent of the shared git directory. `--git-common-dir`
# points at <main>/.git from every linked worktree (and from the main checkout
# itself); fall back to the first entry of `git worktree list` on older git.
COMMON_DIR="$(git -C "$TARGET_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$COMMON_DIR" ]; then
  MAIN_ROOT="$(dirname "$COMMON_DIR")"
else
  MAIN_ROOT="$(git -C "$TARGET_ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
fi
[ -n "$MAIN_ROOT" ] && [ -d "$MAIN_ROOT" ] \
  || die 2 "could not determine the main checkout from $TARGET_ROOT"

[ -f "$TARGET_ROOT/package.json" ] \
  || die 2 "no package.json in target worktree: $TARGET_ROOT"

# --- pnpm ------------------------------------------------------------------

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  PNPM=()
  [ "$REUSE" = 1 ] || die 2 "neither pnpm nor corepack is on PATH — cannot install (use --reuse)"
fi

# --- dependency hashing -----------------------------------------------------

# Path-independent hash of the dependency inputs. Only the file *contents* feed
# the hash, never the absolute path, so two worktrees with byte-identical
# package.json + pnpm-lock.yaml always hash equal.
hash_deps() {
  local root="$1" out="" f h
  for f in package.json pnpm-lock.yaml; do
    if [ -f "$root/$f" ]; then
      h="$(shasum -a 256 "$root/$f" | awk '{print $1}')"
      out="${out}${f}:${h}"$'\n'
    else
      out="${out}${f}:MISSING"$'\n'
    fi
  done
  printf '%s' "$out" | shasum -a 256 | awk '{print $1}'
}

H_TARGET="$(hash_deps "$TARGET_ROOT")"
H_MAIN="$(hash_deps "$MAIN_ROOT")"

STORE_HASH_FILE="$MAIN_ROOT/tmp/.worktree-deps.hash"
TARGET_STAMP_DIR="$TARGET_ROOT/node_modules"
TARGET_STAMP="$TARGET_STAMP_DIR/.worktree-deps.hash"

valid_nm() { [ -f "$1/node_modules/.modules.yaml" ]; }

# True when the install manifest is at least as new as the dependency inputs —
# i.e. the tree was installed after its current lockfile/package.json. This is
# the signal used to trust (adopt) a valid but unstamped install without
# needlessly reinstalling it.
nm_fresh() {
  local root="$1" f
  local nm="$root/node_modules/.modules.yaml"
  [ -f "$nm" ] || return 1
  for f in package.json pnpm-lock.yaml; do
    [ -f "$root/$f" ] || continue
    [ "$root/$f" -nt "$nm" ] && return 1
  done
  return 0
}

# --- lock -------------------------------------------------------------------

LOCK_DIR="$TARGET_ROOT/tmp/.worktree-setup.lock"
acquire_lock() {
  mkdir -p "$TARGET_ROOT/tmp"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  local old=""
  [ -f "$LOCK_DIR/pid" ] && old="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    die 3 "another worktree-setup run (pid $old) holds the lock: $LOCK_DIR"
  fi
  warn "reclaiming stale lock (pid ${old:-unknown}): $LOCK_DIR"
  [ -f "$LOCK_DIR/pid" ] && rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || die 3 "could not reclaim stale lock: $LOCK_DIR"
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

# Invoked via `trap release_lock EXIT INT TERM`; shellcheck cannot see that.
# shellcheck disable=SC2329
release_lock() {
  [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] || return 0
  [ -f "$LOCK_DIR/pid" ] && rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap release_lock EXIT INT TERM

# --- provisioning primitives ------------------------------------------------

stamp_target() {
  mkdir -p "$TARGET_STAMP_DIR"
  printf '%s\n' "$1" > "$TARGET_STAMP"
}

write_stored_hash() {
  mkdir -p "$MAIN_ROOT/tmp"
  printf '%s\n' "$1" > "$STORE_HASH_FILE"
}

# Move a node_modules tree that is present but not a valid pnpm install away
# (never delete it) into the worktree's canonical ephemeral root.
quarantine_node_modules() {
  [ -e "$TARGET_ROOT/node_modules" ] || return 0
  local q="$TARGET_ROOT/tmp/worktree-setup-quarantine"
  mkdir -p "$q"
  local dest
  dest="$q/node_modules.$(date -u +%Y%m%dT%H%M%SZ).$$"
  warn "quarantining node_modules -> $dest (recoverable; safe to delete once satisfied)"
  mv "$TARGET_ROOT/node_modules" "$dest" \
    || die 4 "could not quarantine existing node_modules at $TARGET_ROOT/node_modules"
}

reuse_method() {
  if [ -n "$MODE" ]; then printf '%s' "$MODE"; return; fi
  if [ "$(uname -s)" = "Darwin" ]; then printf 'clone'; else printf 'hardlink'; fi
}

try_method() {  # $1 = method, $2 = src dir, $3 = dst dir
  case "$1" in
    clone)    cp -cR "$2" "$3" ;;
    hardlink) cp -al "$2" "$3" ;;
    copy)     cp -a  "$2" "$3" ;;
    *) return 1 ;;
  esac
}

provision_by_reuse() {
  local donor="$MAIN_ROOT/node_modules" m
  valid_nm "$MAIN_ROOT" \
    || die 4 "main checkout has no valid node_modules to reuse ($MAIN_ROOT/node_modules)"
  quarantine_node_modules
  m="$(reuse_method)"
  log "reusing main checkout's node_modules via $m (no pnpm invoked)"
  if try_method "$m" "$donor" "$TARGET_ROOT/node_modules"; then return 0; fi
  if [ "$m" != "hardlink" ]; then
    warn "$m failed; falling back to hardlink"
    quarantine_node_modules
    if try_method hardlink "$donor" "$TARGET_ROOT/node_modules"; then return 0; fi
  fi
  warn "hardlink failed; falling back to a deep copy"
  quarantine_node_modules
  try_method copy "$donor" "$TARGET_ROOT/node_modules" \
    || die 4 "failed to reuse node_modules from $donor"
}

# --- fast paths -------------------------------------------------------------

acquire_lock

log "target worktree: $TARGET_ROOT"
log "main checkout:   $MAIN_ROOT"
log "dependency hash: $H_TARGET"

if [ "$FORCE" = 0 ] && valid_nm "$TARGET_ROOT"; then
  CUR_STAMP="$(cat "$TARGET_STAMP" 2>/dev/null || true)"
  if [ "$CUR_STAMP" = "$H_TARGET" ]; then
    log "already provisioned for $H_TARGET — no-op"
    exit 0
  fi
  # Adopt a valid but unstamped install (e.g. a worktree provisioned before this
  # script existed, or on a branch whose deps legitimately differ from main)
  # when its install manifest is newer than its dependency inputs. Adopting
  # records the worktree's own current hash; it never re-installs a tree that
  # pnpm already considers installed and current.
  if [ -z "$CUR_STAMP" ] && nm_fresh "$TARGET_ROOT"; then
    log "adopting existing valid node_modules (stamp absent, install newer than dep inputs) — no-op"
    stamp_target "$H_TARGET"
    if [ ! -f "$STORE_HASH_FILE" ] && [ "$H_TARGET" = "$H_MAIN" ] && valid_nm "$MAIN_ROOT"; then
      write_stored_hash "$H_MAIN"
    fi
    exit 0
  fi
fi

STORED="$(cat "$STORE_HASH_FILE" 2>/dev/null || true)"

donor_authoritative() {
  valid_nm "$MAIN_ROOT"  || return 1          # main must hold a real install
  [ "$H_TARGET" = "$H_MAIN" ] || return 1     # deps must be identical to main's
  [ -z "$STORED" ] || [ "$STORED" = "$H_MAIN" ] || return 1  # main not stale
  return 0
}

# --- reuse path (opt-in) ----------------------------------------------------

if [ "$REUSE" = 1 ]; then
  donor_authoritative \
    || die 4 "cannot reuse main's node_modules: dependency inputs differ from main, or main has no/stale install (run without --reuse to install)"
  provision_by_reuse
  stamp_target "$H_TARGET"
  [ -f "$STORE_HASH_FILE" ] || write_stored_hash "$H_MAIN"
  valid_nm "$TARGET_ROOT" \
    || die 6 "reuse finished but $TARGET_ROOT/node_modules/.modules.yaml is missing"
  log "provisioned via reuse from main (hash $H_TARGET)"
  exit 0
fi

# --- default path: real install ---------------------------------------------

# A partial tree is quarantined first so it cannot be silently mixed with a
# correct install. A valid existing tree is upgraded in place by pnpm.
if [ -e "$TARGET_ROOT/node_modules" ] && ! valid_nm "$TARGET_ROOT"; then
  quarantine_node_modules
fi

log "running: ${PNPM[*]} install --frozen-lockfile --prefer-offline"
if ! ( cd "$TARGET_ROOT" && "${PNPM[@]}" install --frozen-lockfile --prefer-offline ); then
  die 5 "pnpm install --frozen-lockfile failed in $TARGET_ROOT"
fi

valid_nm "$TARGET_ROOT" \
  || die 6 "pnpm install reported success but $TARGET_ROOT/node_modules/.modules.yaml is missing"

stamp_target "$H_TARGET"

# The shared stamp describes the MAIN checkout's last known-good install. A
# real install in the main checkout updates it; a worktree install does not
# (main's node_modules is unchanged, so its stamp must not move). Bootstrap it
# from a valid main when it is absent.
if [ "$TARGET_ROOT" = "$MAIN_ROOT" ]; then
  write_stored_hash "$H_TARGET"
  log "installed in main checkout; stored hash updated to $H_TARGET"
else
  if [ -z "$STORED" ] && [ "$H_TARGET" = "$H_MAIN" ] && valid_nm "$MAIN_ROOT"; then
    write_stored_hash "$H_MAIN"
  fi
  log "installed in worktree for $H_TARGET (main checkout stamp unchanged: ${STORED:-<none>})"
fi
exit 0
