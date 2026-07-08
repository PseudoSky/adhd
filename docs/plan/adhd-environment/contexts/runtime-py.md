# runtime-py

**Phase:** runtime · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `true`

---

## Goal

The `adhd-environment` Python package provides a thin runtime client (~40 lines) at `packages/environment/environment-core-py/`. It reads a snapshot JSON and exposes `Environment.get()` for config, paths, env vars, and provenance — identical API surface to the TypeScript runtime. No builder logic, no `.env` loading.

---

## Acceptance criteria




```text
read_only:  []
mutates:    ["packages/environment/environment-core-py/src/adhd_environment/__init__.py", "packages/environment/environment-core-py/src/adhd_environment/environment.py"]
```

- [runtime-py.2] Python tests pass
---

## Notes for executor

1. Pure stdlib — no runtime dependencies. `jsonschema` is optional (for validation, not needed for reading).
2. The runtime is a JSON file reader with typed accessors — no builder logic.
3. `contentHash()` is the cross-language gate — must match TS/Rust byte-for-byte.
4. pyproject.toml and project.json were created by `scaffold-workspace` — only implement source files here.
5. See `interfaces-architect.md` §2 for the exact API spec.