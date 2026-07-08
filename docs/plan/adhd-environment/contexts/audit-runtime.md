# audit-runtime

**Phase:** audit · **Kind:** audit · **Depends on:** runtime-core-node, runtime-cli, runtime-py, runtime-rs · **Guard:** `true`

---

## Goal

Verify that all runtime clients (TypeScript, Python, Rust) and the CLI produce consistent results from the same snapshot. Cross-language validation gates must pass.

---

## Acceptance criteria

- [audit-runtime.1] `npx nx build environment-core-node` exits 0
- [audit-runtime.2] `python -m build` (environment-core-py) produces valid wheel
- [audit-runtime.3] `cargo build` (environment-core-rs) exits 0
- [audit-runtime.4] `npx nx build environment-cli` exits 0
- [audit-runtime.5] TypeScript `contentHash({b:"2",a:"1"})` = Python `contentHash({"b":"2","a":"1"})` = Rust `contentHash({"b":"2","a":"1"})` = `"sha256-9f86d081..."` (byte-identical)
- [audit-runtime.6] Same snapshot → all three `Environment.get("config.server.port")` return `3000`
- [audit-runtime.7] CLI `adhd-env build --namespace production` writes valid snapshot
- [audit-runtime.8] `adhd-env set` + `adhd-env build` round-trips correctly

---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_audit-runtime.py"]
```

---

## Notes for executor

1. Cross-language contentHash is the primary gate — if the test vector doesn't match in all 3, the runtime is wrong.
2. All runtimes read the SAME snapshot file — test with a snapshot built by the CLI.
3. If Python or Rust tests fail, fix in the owning state (runtime-py or runtime-rs), not in this audit.