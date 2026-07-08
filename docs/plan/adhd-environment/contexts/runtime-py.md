# runtime-py

**Phase:** runtime · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `true`

---

## Goal

The `adhd-environment` Python package provides a thin runtime client (~40 lines) at `packages/environment/environment-core-py/`. It reads a snapshot JSON and exposes `Environment.get()` for config, paths, env vars, and provenance — identical API surface to the TypeScript runtime. No builder logic, no `.env` loading.

---

## Acceptance criteria

- [runtime-py.1] `Environment(project="agent-mcp", namespace="production")` constructs from existing snapshot
- [runtime-py.2] `env.get("config.server.port")` returns `3000`
- [runtime-py.3] `env.get("path.state.data")` returns directory path string
- [runtime-py.4] `env.get("env.OPENAI_API_KEY")` returns recorded env var value
- [runtime-py.5] `env.hash` returns `"sha256-"` + 64 hex chars
- [runtime-py.6] `contentHash({"b": "2", "a": "1"})` returns `"sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"`
- [runtime-py.7] `pytest tests/ -v` passes
- [runtime-py.8] `python -m build` produces valid wheel

---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-core-py/src/adhd_environment/__init__.py", "packages/environment/environment-core-py/src/adhd_environment/environment.py"]
```

---

## Notes for executor

1. Pure stdlib — no runtime dependencies. `jsonschema` is optional (for validation, not needed for reading).
2. The runtime is a JSON file reader with typed accessors — no builder logic.
3. `contentHash()` is the cross-language gate — must match TS/Rust byte-for-byte.
4. pyproject.toml and project.json were created by `scaffold-workspace` — only implement source files here.
5. See `interfaces-architect.md` §2 for the exact API spec.