---
package: @adhd/apigen-python-env
path: /Users/nix/dev/node/adhd/packages/apigen/python-env
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [APIGEN_PYTHON, APIGEN_PYENV_HOME]
writes: [{path: ~/.adhd/apigen/pyvenv, kind: state}, {path: ~/.adhd/apigen/pyvenv/.apigen-stamp, kind: config}, {path: ~/.adhd/apigen/pyvenv.lock, kind: state}, {path: os.tmpdir()/apigen-python-wheel-*, kind: temp}]
config_files: []
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: none
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G1]
value: high
effort: low
recommend: adopt-after-gap
---

## Current state

**Environment variables:**
- `APIGEN_PYTHON` · read in `ensurePythonEnv()` line 192 · no default; if present, used as explicit interpreter path (power-user override, CI pre-provisioned interpreters)
- `APIGEN_PYENV_HOME` · read in `ensurePythonEnv()` line 203 · default fallback to `~/.adhd/apigen`

**File writes:**
- `~/.adhd/apigen/pyvenv/` · state directory · managed Python venv created via `python3 -m venv` (line 235)
- `~/.adhd/apigen/pyvenv/bin/python3` (macOS/Linux) or `.../Scripts/python.exe` (Windows) · state · interpreter from the venv
- `~/.adhd/apigen/pyvenv/.apigen-stamp` · config file · JSON stamp tracking `pyprojectHash` and provisioned `extras[]` for health checks (line 292)
- `~/.adhd/apigen/pyvenv.lock` · state directory · cross-process exclusive lock via atomic `mkdir` (line 219), broken after 5min timeout

**Scope behavior:**
- Hardcoded to `~/.adhd/apigen` via `os.homedir()` (line 203)
- No support for project-scope or system-scope variants
- Lock and stamp live alongside the venv, not in a separate namespace

**Logging & error handling:**
- No logging at all — no console, no pino/winston, no log files
- Errors thrown synchronously as exceptions with clear messages (lines 111–115, 195, 238, 263, 271, 282)
- No try/catch propagation — callers must handle exceptions or crash
- Robust error messages name the exact problem and the install/config step

## Proposed `EnvironmentSpec`

```typescript
export const pythonEnvSpec = {
  config: {
    pythonOverride: {
      type: 'string',
      env: 'APIGEN_PYTHON',
      secret: false,
      default: undefined,
      description: 'Absolute path to an explicit Python interpreter (power users, CI pre-provisioned).',
    },
  },
  dirs: {
    pyenvHome: {
      kind: 'state',
      description: 'Root directory for managed Python venv and lock.',
    },
  },
  envPrefixOverride: 'APIGEN',
} as const
```

Then in code:

```typescript
const override = env.config.pythonOverride
const envHome = env.paths.pyenvHome
const venvDir = path.join(envHome, 'pyvenv')
const lockDir = path.join(envHome, 'pyvenv.lock')
```

This preserves the `APIGEN_PYTHON` and `APIGEN_PYENV_HOME` env names (via `envPrefixOverride: 'APIGEN'`) while gaining:
- Scope awareness (global `~/.adhd/apigen`, project `./.adhd/apigen`, or system scope)
- Lazy directory creation via `env.paths`
- Per-instance file locking support if `share: 'per-instance'` is added later

## Gap detail

**G1** — Non-`ADHD_*` env vars `APIGEN_PYTHON` and `APIGEN_PYENV_HOME` are established API; renaming to `ADHD_APIGEN_PYTHON` would break existing CI images and manual overrides. The `envPrefixOverride: 'APIGEN'` workaround preserves backward compatibility but adds one env-reading entrypoint outside the uniform `ADHD_*` guard.

## Logging audit

**Does it log?** No. The module is initialization-time only and communicates success/failure via return value or thrown exception. Callers wrap the call in try/catch and decide whether to log or exit.

**Error handling:** Robust — every error path (lines 111, 195, 238, 263, 271, 282) constructs a specific message naming the problem (missing Python, missing interpreter, spawn failure, pip failure, malformed stamp). A caller that logs exceptions will expose these messages. No silent fallbacks.

**Would it benefit from `env.paths.logs`?** No. This is not a daemon or long-running service; it runs synchronously at plugin startup and exits. Log files would be noise (transient, one file per run, nothing to trend). Exception propagation to a logged caller is sufficient.

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `~/.adhd/apigen/pyvenv` | state | `~/.adhd/apigen-python-env/default/state/pyvenv` | `path.join(env.paths.state, 'pyvenv')` |
| `~/.adhd/apigen/pyvenv/.apigen-stamp` | config | `~/.adhd/apigen-python-env/default/config/.apigen-stamp` | `path.join(env.paths.config, '.apigen-stamp')` |
| `~/.adhd/apigen/pyvenv.lock` | state | `~/.adhd/apigen-python-env/default/state/pyvenv.lock` | `path.join(env.paths.state, 'pyvenv.lock')` |
| `os.tmpdir()/apigen-python-wheel-*` | temp | `~/.adhd/apigen-python-env/default/temp/wheel-<stamp>` | `path.join(env.paths.temp, 'wheel-<stamp>')` |

**Project-scope variant:** When `ADHD_ENV_SCOPE=project` is set (or `.git`/`.adhd` marker detected), the same paths root at `<projectRoot>/.adhd/apigen-python-env/default/{state|config|temp}/…` instead of `~/.adhd/…`.
