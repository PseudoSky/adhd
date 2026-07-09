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

## Fixed

### DEFER-PYENV-002 — pip directory-install emits in-tree byproducts
`pip install <packages/apigen/python>[extras]` left `build/` + `*.egg-info/` inside
the source tree (setuptools metadata generation). Fixed by building a wheel in a temp
directory (`os.tmpdir()`) via `pip wheel --no-deps --wheel-dir <tmp>` then installing
that wheel — the source tree is never touched. Old `build/` and `*.egg-info/` artifacts
are cleaned up during provisioning.

### DEFER-PYENV-001 — Windows support untested
`venvPython()` handles the `Scripts/python.exe` layout, but bootstrap/locking has only
been exercised on macOS/Linux.

---

## Revalidation (2026-07-04) — verified against current source

| Item | Status | Notes |
|------|--------|-------|
| DEFER-PYENV-002 — pip in-tree byproducts | **STILL OPEN** | `build/` and `*.egg-info/` still created by `pip install` (gitignore mitigation in place). No wheel-building in temp dir implemented. `ensurePythonEnv()` at `packages/apigen/python-env/src/lib/python-env.ts:244-248` still does plain `pip install <dir>`. |
| DEFER-PYENV-001 — Windows support | **STILL OPEN (slightly worse)** | `venvPython()` handles `Scripts/python.exe` correctly. BUT `BASE_CANDIDATES` (`python3.13`, `python3.12`, `python3.11`, `python3`) would **fail on Windows** — standard names are `python.exe`, `python3.exe`, or `py -3.x`. No `python`/`python.exe` in candidates. Zero Windows-specific tests. |
