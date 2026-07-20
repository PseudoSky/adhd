---
package: apigen-python
path: /Users/nix/dev/node/adhd/packages/apigen/python
root: adhd
language: python
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [
  {path: "conformance_vectors.json", kind: "data", purpose: "test fixture cache"}
]
config_files: []
supported_by_env: no
gaps: [G3, G2]
value: low
effort: high
recommend: skip
---

## Current state

No environment variables read by the package. All CLI entry points (`apigen-python-extractor`, `apigen-python-adapter`, `apigen-python-flask-server`, `apigen-python-grpc-server`) accept positional arguments and `--flag` options:

- **extractor**: `source` (required, file path), `--namespace` (optional, defaults to normalised stem)
- **gateway adapter**: `--module` (optional, path to module), `--namespace` (optional)
- **flask server**: `--module` (required), `--namespace` (required), `--host` (default: 127.0.0.1), `--port` (default: 8000)
- **grpc server**: `--module` (required), `--namespace` (required), `--host` (default: 127.0.0.1), `--port` (default: 50051)

Tests write a fixture file to `<repo>/packages/apigen/python/conformance_vectors.json` (cached copy of logical-type test vectors generated from Node.js conformance suite). No logging configuration, no config files, no persistent state.

## Proposed `EnvironmentSpec`

Python packages cannot use `@adhd/environment` — no implementation exists for the language. A spec written in TypeScript target shape for future migration:

```typescript
const spec: EnvironmentSpec<typeof config> = {
  config: {
    module: {
      type: "string",
      env: "APIGEN_PYTHON_MODULE",
      description: "Path to the Python module to serve/extract",
    },
    namespace: {
      type: "string",
      env: "APIGEN_PYTHON_NAMESPACE",
      description: "Namespace slug (proto package name / URL prefix)",
    },
    host: {
      type: "string",
      env: "APIGEN_PYTHON_HOST",
      default: "127.0.0.1",
      description: "Bind host for HTTP/gRPC servers",
    },
    port: {
      type: "integer",
      env: "APIGEN_PYTHON_PORT",
      default: 8000,
      minimum: 1,
      maximum: 65535,
      description: "TCP port (server mode)",
    },
  },
  dirs: {
    fixtures: {
      kind: "data",
      description: "Test fixture cache (conformance vectors)",
    },
  },
  files: {
    conformance_vectors: {
      in: "fixtures",
      name: "conformance_vectors.json",
      description: "Cached logical-type test vectors from Node.js conformance suite",
    },
  },
};
```

## Gap detail

- **G3**: Python language. `@adhd/environment` has no Python runtime; would require independent implementation of environment-resolution, cascading, and path-management logic.
- **G2**: Test fixture path hardcoded as `SCRIPT_DIR / "conformance_vectors.json"` in `run_tests.py` line 90. Writes to repo-relative path, not scoped under `~/.adhd` or project `.adhd/`.

## File-location table

| Current path | Kind | Proposed env.paths/env.files key |
|---|---|---|
| `<repo>/packages/apigen/python/conformance_vectors.json` | data | `env.files.conformance_vectors` (under `env.paths.fixtures`) |
| CLI `--module` argument | config | `env.config.module` |
| CLI `--namespace` argument | config | `env.config.namespace` |
| CLI `--host` argument | config | `env.config.host` |
| CLI `--port` argument | config | `env.config.port` |
| `PYTHONPATH` (test only, set by parent process) | state | not applicable (set by test harness, not package) |
