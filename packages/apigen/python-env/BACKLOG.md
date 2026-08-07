### DEFER-PYENV-002 — pip directory-install emits in-tree byproducts

**Status:** UNKNOWN

`pip install <packages/apigen/python>[extras]` left `build/` + `*.egg-info/` inside
the source tree (setuptools metadata generation). Fixed by building a wheel in a temp
directory (`os.tmpdir()`) via `pip wheel --no-deps --wheel-dir <tmp>` then installing
that wheel — the source tree is never touched. Old `build/` and `*.egg-info/` artifacts
are cleaned up during provisioning.

### DEFER-PYENV-001 — Windows support untested

**Status:** UNKNOWN

`venvPython()` handles the `Scripts/python.exe` layout, but bootstrap/locking has only
been exercised on macOS/Linux.

---
