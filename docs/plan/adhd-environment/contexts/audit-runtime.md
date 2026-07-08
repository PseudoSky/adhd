# audit-runtime

**Phase:** audit · **Kind:** audit · **Depends on:** runtime-core-node, runtime-cli, runtime-py, runtime-rs · **Guard:** `true`

---

## Goal

Verify that all runtime clients (TypeScript, Python, Rust) and the CLI produce consistent results from the same snapshot. Cross-language validation gates must pass.

---

## Acceptance criteria




read_only:  []
mutates:    ["scripts/audit_audit-runtime.py"]
```

- [audit-runtime.1] TS runtime package builds
---

## Notes for executor

1. Cross-language contentHash is the primary gate — if the test vector doesn't match in all 3, the runtime is wrong.
2. All runtimes read the SAME snapshot file — test with a snapshot built by the CLI.
3. If Python or Rust tests fail, fix in the owning state (runtime-py or runtime-rs), not in this audit.