# BACKLOG — @adhd/apigen-python-env

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ *Extraction performance + memory-leak work (2026-07-02)*).

## Origin

Created 2026-07-02 to fix BUG-APIGEN-016: py-grpc/py-flask spawned bare PATH `python3`
and hoped grpcio was installed — the dependency lived outside the repo's packaging.
This package makes `packages/apigen/python/pyproject.toml` the single source of truth
by provisioning a managed venv (`~/.adhd/apigen/pyvenv`) from its extras.

## Fixed

- BUG-APIGEN-017 (in `packages/apigen/python`): pyproject declared the non-existent
  backend `setuptools.backends.legacy:build`; any `pip install` of the package failed.
  Fixed to `setuptools.build_meta` (exercised for real by this package's venv tests).
- Extras-thrash race: concurrent consumers with different extras (flask wants none,
  grpc wants `grpc`) could rebuild the shared venv without each other's deps. Extras are
  now monotonic (union on rebuild; subset requests are healthy). Guard:
  `src/test/python-env.spec.ts`.

## Open

### DEFER-PYENV-002 — pip directory-install emits in-tree byproducts
`pip install <packages/apigen/python>[extras]` leaves `build/` + `*.egg-info/` inside
the source tree (setuptools metadata generation). Both are gitignored now; the clean fix
is building a wheel in a temp dir and installing that.

### DEFER-PYENV-001 — Windows support untested
`venvPython()` handles the `Scripts/python.exe` layout, but bootstrap/locking has only
been exercised on macOS/Linux.
