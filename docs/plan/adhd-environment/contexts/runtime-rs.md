# runtime-rs

**Phase:** runtime · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `true`

---

## Goal

The `adhd-environment` Rust crate provides a thin runtime client (~50 lines) at `packages/environment/environment-core-rs/`. It reads a snapshot JSON and exposes `Environment.get()` for config, paths, env vars, and provenance — identical API surface to the TypeScript runtime. No builder logic.

---

## Acceptance criteria

- [runtime-rs.2] Rust tests pass
---


```text
read_only:  []
mutates:    ["packages/environment/environment-core-rs/src/lib.rs"]
```

---

## Notes for executor

1. Dependencies: `serde`, `serde_json`, `sha2` for JSON parsing and hashing.
2. The runtime is a JSON file reader — no builder logic, no validation.
3. `contentHash()` must match TS/Python test vector byte-for-byte.
4. Use `serde_json::Value` for the untyped `get()` return; provide typed helpers (`get_str`, `get_int`, `get_bool`).
5. Cargo.toml and project.json were created by `scaffold-workspace` — only implement `src/lib.rs` here.
6. See `interfaces-architect.md` §2 for the exact API spec.