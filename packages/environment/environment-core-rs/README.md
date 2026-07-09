# adhd-environment (`environment-core-rs`)

The Rust runtime client for the `@adhd/environment` family. Distributed on crates.io
as **`adhd-environment`**; used in Rust as `adhd_environment`.

```toml
[dependencies]
adhd-environment = "0.0.1"
```

```rust
use adhd_environment;
```

## Building & testing (via nx)

This is a first-class nx project even though it is not a TypeScript package. Its
targets are driven by `nx-run.sh`, which resolves `rustup` from `PATH` or the
Homebrew keg-only path (`/opt/homebrew/opt/rustup/bin/rustup`, not on `PATH` by
default) and fails loudly if absent. The toolchain `1.95.0` is pinned by
`rust-toolchain.toml` and named explicitly in the script:

- Build: `nx build environment-core-rs` → `rustup run 1.95.0 cargo build`
- Test:  `nx test environment-core-rs` → `rustup run 1.95.0 cargo test`
- Publish: `nx-release-publish` target → `rustup run 1.95.0 cargo publish`
  (`CARGO_REGISTRY_TOKEN` supplied by the release environment; never committed — not
  run automatically)

`platform:rust` — this package is intentionally outside the Node/browser TypeScript
graph and must not import Node-TS or browser code.

## `@adhd/environment` family — naming map

| directory | nx project name | distribution name | registry | import specifier |
|-----------|-----------------|-------------------|----------|------------------|
| `packages/environment/environment-base-spec` | `environment-base-spec` | `@adhd/environment-base-spec` | npm | `@adhd/environment-base-spec` |
| `packages/environment/environment-builder` | `environment-builder` | `@adhd/environment-builder` | npm | `@adhd/environment-builder` |
| `packages/environment/environment-core-node` | `environment-core-node` | `@adhd/environment` | npm | `@adhd/environment` |
| `packages/environment/environment-core-py` | `environment-core-py` | `adhd-environment` | PyPI | `import adhd_environment` |
| `packages/environment/environment-core-rs` | `environment-core-rs` | `adhd-environment` | crates.io | `use adhd_environment;` (crate `adhd-environment`) |
| `entrypoint/environment-cli` | `environment-cli` | `@adhd/environment-cli` | npm | `@adhd/environment-cli` |

The crates.io crate `adhd-environment` is the cross-registry mirror of the deliberate
unprefixed npm alias `@adhd/environment` (see the headline README,
`packages/environment/environment-core-node/README.md`). The crate is named
`adhd-environment`; the Rust library path replaces the hyphen with an underscore
(`adhd_environment`).

### Renames performed in this task

**None.** This package's nx project name `environment-core-rs` was **newly assigned**
(it had no `project.json` before and was invisible to `nx show projects`); that is a
first-time wiring, not a rename. The crate name `adhd-environment` was already set in
`Cargo.toml` and left unchanged.
