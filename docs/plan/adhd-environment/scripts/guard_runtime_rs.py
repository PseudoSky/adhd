#!/usr/bin/env python3
"""guard_runtime_rs.py — environment-pinned guard for the `runtime-rs` state.

Replaces the bare, ambient-PATH guard `cargo build`. A bare `cargo` on this
machine resolves to the homebrew `rust` formula's cargo, which is NOT the pinned
1.95.0 toolchain the plan targets, and the env-pin heuristic has no cargo/rustup
marker (see BACKLOG ENV-PLAN-002 / ENV-PLAN-005). This guard resolves the pinned
Rust toolchain EXPLICITLY through rustup and builds with `rustup run 1.95.0 cargo
build`, matching `environment-core-rs/rust-toolchain.toml` (channel 1.95.0).

rustup is keg-only on this machine (not on PATH). We resolve it via
`shutil.which("rustup")` first, then fall back to the known homebrew keg location
`/opt/homebrew/opt/rustup/bin/rustup`, and FAIL LOUDLY (non-zero + stderr) if
neither exists — never a silent skip.

Contract: RED (non-zero) until `runtime-rs` implements `src/lib.rs` and it
compiles under 1.95.0; GREEN (zero) afterwards. The `python3 …​.py` guard STRING
is recognised as environment-pinned by the env-pin heuristic.
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
PKG_DIR = REPO_ROOT / "packages" / "environment" / "environment-core-rs"
PIN_TOOLCHAIN = "1.95.0"
RUSTUP_FALLBACK = "/opt/homebrew/opt/rustup/bin/rustup"


def resolve_rustup() -> str:
    rustup = shutil.which("rustup")
    if rustup:
        return rustup
    if Path(RUSTUP_FALLBACK).exists():
        return RUSTUP_FALLBACK
    sys.stderr.write(
        "guard_runtime_rs: FATAL — `rustup` not found on PATH nor at "
        f"{RUSTUP_FALLBACK}. Install rustup (brew install rustup) and the "
        f"{PIN_TOOLCHAIN} toolchain so the Rust guard can pin its compiler. "
        "Refusing to fall back to a bare/homebrew `cargo` (wrong toolchain).\n"
    )
    sys.exit(2)


def main() -> int:
    if not PKG_DIR.is_dir():
        sys.stderr.write(f"guard_runtime_rs: FATAL — package dir missing: {PKG_DIR}\n")
        return 2
    rustup = resolve_rustup()
    cmd = [rustup, "run", PIN_TOOLCHAIN, "cargo", "build"]
    sys.stderr.write(f"guard_runtime_rs: running {' '.join(cmd)} in {PKG_DIR}\n")
    proc = subprocess.run(cmd, cwd=str(PKG_DIR))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_runtime_rs: RED — `rustup run {PIN_TOOLCHAIN} cargo build` "
            f"exited {proc.returncode}. environment-core-rs does not compile yet.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
