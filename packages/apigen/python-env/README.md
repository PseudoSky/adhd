# @adhd/apigen-python-env

Python host provisioning for apigen's `py-*` plugins.

## The problem it solves

`py-grpc` / `py-flask` spawn a Python process (`apigen_python.grpc_server` /
`flask_server`). Those servers need `grpcio` + `grpcio-reflection` — deps that
are **declared in `packages/apigen/python/pyproject.toml`** (the `grpc` extra),
but that used to be expected on whatever `python3` happened to be on PATH.
On any machine without them, `apigen run/serve --type py-grpc` died on import.

This package makes the Python packaging the single source of truth: it
provisions a **managed venv** by `pip install`-ing `apigen-python` (with the
requested extras) from its own `pyproject.toml`, and hands back that venv's
interpreter.

## API

```ts
import { ensurePythonEnv, resolvePythonPkgDir } from '@adhd/apigen-python-env'

const { python, venvDir, pythonPkgDir } = ensurePythonEnv({ extras: ['grpc'] })
// spawn(python, ['-m', 'apigen_python.grpc_server', ...], { env: { PYTHONPATH: pythonPkgDir } })
```

- **`ensurePythonEnv({ extras })`** — returns the interpreter to spawn.
  Resolution order:
  1. `APIGEN_PYTHON` env var (explicit override — CI images, power users).
  2. Managed venv at `~/.adhd/apigen/pyvenv` — created on first use, refreshed
     automatically when `pyproject.toml` (or the requested extras) change
     (content-hash stamp file). Creation is cross-process locked, so
     concurrent `serve` children don't double-provision.
- **`resolvePythonPkgDir()`** — locates the `apigen_python` sources (shared by
  both py plugins; also exported for tools like the conformance gate).

Environment knobs:

| Var | Effect |
| --- | ------ |
| `APIGEN_PYTHON` | Skip the managed venv; use this interpreter as-is. |
| `APIGEN_PYENV_HOME` | Relocate the managed-venv root (tests point it at `tmp/`). |

## Failure mode

Loud, never silent: if no Python ≥ 3.11 is on PATH or `pip install` fails, the
error says exactly what to install. The plugins no longer fall back to a bare
`python3` that may be missing its deps.

## Consumers

- `@adhd/apigen-plugin-py-grpc` — `ensurePythonEnv({ extras: ['grpc'] })`
- `@adhd/apigen-plugin-py-flask` — `ensurePythonEnv()` (stdlib HTTP fallback needs no extras)
- `apigen serve` — pre-provisions before spawning Python hosts so child ready
  timeouts don't absorb a first-time venv build, and pins children via
  `APIGEN_PYTHON`.
