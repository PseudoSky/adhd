#!/usr/bin/env sh
# nx target driver for environment-core-rs (crates.io: adhd-environment).
# Resolves `rustup` from PATH, then the Homebrew keg-only fallback
# (/opt/homebrew/opt/rustup/bin/rustup, NOT on PATH by default), and fails
# loudly if neither exists. Toolchain 1.95.0 is pinned by rust-toolchain.toml;
# it is named explicitly here so the target is reproducible regardless of the
# active default toolchain. Invoked by project.json build/test/nx-release-publish.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

RUSTUP=$(command -v rustup 2>/dev/null || true)
if [ -z "$RUSTUP" ] && [ -x /opt/homebrew/opt/rustup/bin/rustup ]; then
  RUSTUP=/opt/homebrew/opt/rustup/bin/rustup
fi
if [ -z "$RUSTUP" ]; then
  echo "FATAL: rustup not found on PATH or at /opt/homebrew/opt/rustup/bin/rustup" >&2
  exit 127
fi

TOOLCHAIN=1.95.0

case "${1:-}" in
  build)   exec "$RUSTUP" run "$TOOLCHAIN" cargo build ;;
  test)    exec "$RUSTUP" run "$TOOLCHAIN" cargo test ;;
  # publish is intentionally NOT wired to real credentials here;
  # CARGO_REGISTRY_TOKEN is supplied by the release environment, never committed.
  publish) exec "$RUSTUP" run "$TOOLCHAIN" cargo publish ;;
  *) echo "usage: nx-run.sh {build|test|publish}" >&2; exit 2 ;;
esac
