#!/usr/bin/env python3
"""guard_runtime_rs.py — environment-pinned guard for the Rust runtime.

Replaces bare, ambient-PATH `cargo build` / `cargo test` / `cargo clippy`. A
bare `cargo` on this machine resolves to the homebrew `rust` formula's cargo,
which is NOT the pinned 1.95.0 toolchain the plan targets, and the env-pin
heuristic has no cargo/rustup marker (see BACKLOG ENV-PLAN-002 / ENV-PLAN-005).
This guard resolves the pinned toolchain EXPLICITLY through rustup and runs
`rustup run 1.95.0 cargo <verb>`, matching
`environment-core-rs/rust-toolchain.toml` (channel 1.95.0).

rustup is keg-only on this machine (not on PATH). We resolve it via
`shutil.which("rustup")` first, then fall back to the known homebrew keg
location `/opt/homebrew/opt/rustup/bin/rustup`, and FAIL LOUDLY (non-zero +
stderr) if neither exists — never a silent skip.

Modes (positional arg; default `build` so the pre-existing no-arg dag guard for
the `runtime-rs` state is byte-for-byte unchanged):
    build   rustup run 1.95.0 cargo build
    test    rustup run 1.95.0 cargo test           (F13 pinned cargo test)
    clippy  rustup run 1.95.0 cargo clippy -- -D warnings

Every leg resolves its compiler through the pinned rustup toolchain, so this
guard is INDEPENDENTLY pinned wherever it is invoked (a dag guard string OR a
criteria.json `cmd`). It is the sanctioned replacement for any bare `cargo` leg
an audit gate would otherwise launder past the substring-based env-pin
heuristic (F8). The `python3 …​.py` guard STRING is recognised as
environment-pinned.

Contract: RED (non-zero) until environment-core-rs satisfies the requested verb
under 1.95.0; GREEN (zero) afterwards.
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
PKG_DIR = REPO_ROOT / "packages" / "environment" / "environment-core-rs"
PIN_TOOLCHAIN = "1.95.0"
RUSTUP_FALLBACK = "/opt/homebrew/opt/rustup/bin/rustup"

# mode -> cargo argv
MODES = {
    "build": ["cargo", "build"],
    "test": ["cargo", "test"],
    "clippy": ["cargo", "clippy", "--", "-D", "warnings"],
}


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
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    if mode not in MODES:
        sys.stderr.write(
            f"guard_runtime_rs: FATAL — unknown mode {mode!r} (want one of: {', '.join(MODES)})\n"
        )
        return 2
    if not PKG_DIR.is_dir():
        sys.stderr.write(f"guard_runtime_rs: FATAL — package dir missing: {PKG_DIR}\n")
        return 2
    rustup = resolve_rustup()
    cmd = [rustup, "run", PIN_TOOLCHAIN, *MODES[mode]]
    sys.stderr.write(f"guard_runtime_rs[{mode}]: running {' '.join(cmd)} in {PKG_DIR}\n")
    proc = subprocess.run(cmd, cwd=str(PKG_DIR))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_runtime_rs[{mode}]: RED — exited {proc.returncode}. "
            "environment-core-rs does not satisfy this verb under "
            f"{PIN_TOOLCHAIN} yet.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
