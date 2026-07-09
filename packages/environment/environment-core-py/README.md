# adhd-environment (`environment-core-py`)

The Python runtime client for the `@adhd/environment` family. Distributed on PyPI as
**`adhd-environment`**; imported in Python as `adhd_environment`.

```bash
pip install adhd-environment
```

```python
import adhd_environment
```

## Building & testing (via nx)

This is a first-class nx project even though it is not a TypeScript package. Its
targets are driven by `nx-run.sh`, which resolves `uv` from `PATH` or the Homebrew
keg (`/opt/homebrew/bin/uv`) and fails loudly if absent:

- Build: `nx build environment-core-py` → `uv run --python 3.10 -m build` (wheel + sdist into `dist/`)
- Test:  `nx test environment-core-py` → `uv run --python 3.10 -m pytest tests/`
- Publish: `nx-release-publish` target → `uv publish dist/*` (credentials supplied by
  the release environment; never committed — not run automatically)

`platform:python` — this package is intentionally outside the Node/browser
TypeScript graph and must not import Node-TS or browser code.

## `@adhd/environment` family — naming map

| directory | nx project name | distribution name | registry | import specifier |
|-----------|-----------------|-------------------|----------|------------------|
| `packages/environment/environment-base-spec` | `environment-base-spec` | `@adhd/environment-base-spec` | npm | `@adhd/environment-base-spec` |
| `packages/environment/environment-builder` | `environment-builder` | `@adhd/environment-builder` | npm | `@adhd/environment-builder` |
| `packages/environment/environment-core-node` | `environment-core-node` | `@adhd/environment` | npm | `@adhd/environment` |
| `packages/environment/environment-core-py` | `environment-core-py` | `adhd-environment` | PyPI | `import adhd_environment` |
| `packages/environment/environment-core-rs` | `environment-core-rs` | `adhd-environment` | crates.io | `use adhd_environment;` (crate `adhd-environment`) |
| `entrypoint/environment-cli` | `environment-cli` | `@adhd/environment-cli` | npm | `@adhd/environment-cli` |

The PyPI distribution `adhd-environment` is the cross-registry mirror of the
deliberate unprefixed npm alias `@adhd/environment` (see the headline README,
`packages/environment/environment-core-node/README.md`). PyPI normalizes the
distribution name to `adhd-environment`; the importable module keeps the PEP 8
underscore form `adhd_environment`.

### Renames performed in this task

**None.** This package's nx project name `environment-core-py` was **newly assigned**
(it had no `project.json` before and was invisible to `nx show projects`); that is a
first-time wiring, not a rename. The distribution name `adhd-environment` was already
set in `pyproject.toml` and left unchanged.
