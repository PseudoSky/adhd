---
package: space-recovery
path: /Users/nix/dev/ai/scratch/space-recovery
root: scratch
language: python
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes:
  - path: space_recovery/history/hash-cache-*.json
    kind: state
    purpose: Per-root persistent hash cache keyed by device/inode
  - path: space_recovery/history/dircache.json
    kind: state
    purpose: Directory metadata cache for fast re-scan (size, mtime, ctime, nlink)
  - path: space_recovery/history/inventory-active.json
    kind: data
    purpose: Active scan inventory (results from most recent scan_all_patterns)
config_files:
  - config.json
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: false
supported_by_env: "no"
gaps:
  - G2
  - G3
value: med
effort: high
recommend: skip
---

## Current state

**Env vars:** None read directly from environment.

**Writes:**
- `space_recovery/history/hash-cache-{root_key}.json` · state · Persistent xxhash cache keyed by (device, inode), with reverse index for duplicate detection. Built incrementally as files are hashed during scan.
- `space_recovery/history/dircache.json` · state · Per-directory metadata (size, mtime, ctime, nlink, max_mtime, max_ctime) for fast re-scan; cached entries skip full walks when unchanged.
- `space_recovery/history/inventory-active.json` · data · Complete scan results (patterns found, totals, counts) stamped with config.json mtime for staleness detection.

**Config files:**
- `config.json` · Root-level JSON with 40+ "patterns" (directory/glob/file_count/zero_byte/temporal_cohort/duplicate_files matchers), exclusion rules, verify blocks. Loaded by `load_patterns()` (not in flagged files but called by scanner.py).

**Scope behavior:** Hardcoded relative to package source.
- `HASH_CACHE_DIR = Path(__file__).resolve().parent.parent / "history"` (line 5, hash_cache.py)
- `CACHE_DIR = Path(__file__).resolve().parent.parent / "history"` (line 12, scanner.py)
- All persistent state written to a single `space_recovery/history/` directory at package source root, not under user home, project, or `.adhd`.
- `config.json` path inferred to be package root (DEFAULT_CONFIG_PATH referenced but not defined in flagged files).

## Proposed `EnvironmentSpec`

```typescript
// Not applicable: space-recovery is Python, @adhd/environment is Node-only (G3).
// Shown as target shape for reference if Python implementation existed:

const spec: EnvironmentSpec<SpaceRecoveryConfig> = {
  envPrefixOverride: "SPACE_RECOVERY",
  dirs: {
    history: { kind: "state", share: "per-instance", namespace: "default" },
  },
  files: {
    config: { in: "history", name: "config.json" },
    active_inventory: { in: "history", name: "inventory-active.json" },
  },
  config: {
    // config.json itself becomes env-manageable (read from paths.config, not cwd)
  },
};
```

## Gap detail

- **G2:** Writes to hardcoded `space_recovery/history/` directory relative to package source code location. On module import, that path is computed once and reused; no env-driven scoping or per-instance isolation possible. Path is not configurable, not user-writable, and not suitable for multi-instance scenarios (e.g., parallel scans of different roots).
- **G3:** space-recovery is Python; `@adhd/environment` exists only for Node/TypeScript. Python lacks a cascade/scoping/dir-mgmt counterpart. Full adoption requires a Python port of @adhd/environment (out of scope here).

## Logging audit

**Summary:** No logging. Only `questionary` (interactive prompts) and `rich` (terminal output, summary tables) are used.

**Mechanism:** None. No import of `logging`, `pino`, `winston`, or custom logger. Console output is driven by `questionary.prompt()` and `rich` table/panel rendering.

**Persistence:** No `.log` files written. stdout/stderr only.

**Structured:** No. Output is plaintext terminal formatting (rich tables/panels).

**Error handling:** Adhoc via `try/except` blocks catching `(OSError, PermissionError)` and `json.JSONDecodeError`. Errors are silently swallowed (e.g., hash_cache.py lines 42–53, 142–149, scanner.py lines 180–181, 274–275, 399–403). No error-level logging, no propagation to caller (returns `None`/`0`/empty dict instead).

**Benefit from env.paths.logs:** Yes. Errors (hash computation failures, walk timeout, permission issues) are silently dropped. A per-instance `env.paths.logs` directory with structured error logging would improve debuggability and allow multi-instance scans to maintain separate error trails without file collisions.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `space_recovery/history/hash-cache-{root_key}.json` | state | `~/.adhd/space-recovery/default/state/hash-cache-{root_key}.json` | `env.paths.state / f"hash-cache-{root_key}.json"` |
| `space_recovery/history/dircache.json` | state | `~/.adhd/space-recovery/default/state/dircache.json` | `env.paths.state / "dircache.json"` |
| `space_recovery/history/inventory-active.json` | data | `~/.adhd/space-recovery/default/data/inventory-active.json` | `env.paths.data / "inventory-active.json"` |
| `config.json` (package root) | config | `~/.adhd/space-recovery/default/config/config.json` | `env.files.config` |

**Project-scope variant:** same paths rooted at `<projectRoot>/.adhd/space-recovery/default/{state|data|config}/…` when `ADHD_ENV_SCOPE=project` or `.adhd` marker detected.
