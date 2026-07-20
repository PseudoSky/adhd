---
package: @adhd/apigen-cli
path: /Users/nix/dev/node/adhd/entrypoint/apigen-cli
root: adhd
language: node
self_internal: false
current_scope_behavior: mixed
env_vars: [APIGEN_LOG_LEVEL, APIGEN_LOG_FORMAT, APIGEN_LOG_FILE, APIGEN_PYTHON]
writes: [{path: "<--out-dir>/*", kind: data, purpose: generated schema/API output}, {path: "<--out-dir>/package.json", kind: config, purpose: scaffolding}, {path: "<--out-dir>/tsconfig.json", kind: config, purpose: scaffolding}, {path: "<--out-dir>/node_modules", kind: unknown, purpose: resolution symlinks}, {path: "os.tmpdir()/apigen-tsconfig-*/tsconfig.json", kind: temp, purpose: builtin default fallback}]
config_files: [apigen.config.json, tsconfig.json, default-tsconfig.json]
logging:
  has_logging: true
  logger: pino
  persists_log_files: true
  log_destination: "stderr (default), custom file via APIGEN_LOG_FILE"
  structured: true
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2, G4]
value: med
effort: med
recommend: adopt-after-gap
---

## Current State

**Environment Variables:**
- `APIGEN_LOG_LEVEL` · read in `buildCliLogger()` (logging.ts) · default 'info'
- `APIGEN_LOG_FORMAT` · read in `buildCliLogger()` (logging.ts) · default undefined (raw format unspecified)
- `APIGEN_LOG_FILE` · read in `buildCliLogger()` (logging.ts) · passed to `createLogger({ destination })`
- `APIGEN_PYTHON` · read in `startServe()` (serve.ts, line 1250) · user override for Python interpreter path in multi-source serve

**Files Written:**
- `--out-dir/*` (from generate command) · generated TypeScript/Python schema, API server code, CLI scaffolding · written via `fs.writeFileSync()` in loop
- `--out-dir/package.json` · scaffolding artifact · `emitResolutionScaffolding()` (scaffold.ts, line 272) · written if absent
- `--out-dir/tsconfig.json` · scaffolding artifact for module resolution · `emitResolutionScaffolding()` (scaffold.ts, line 296) · written if absent
- `--out-dir/node_modules` · symlink directory (PRE-PUBLISH ONLY, via `--link-workspace`) or copy of @adhd/* sources · `linkNodeModules()` (scaffold.ts, line 182) · created if absent
- `os.tmpdir()/apigen-tsconfig-*/tsconfig.json` · fallback builtin default · `builtinTsconfigPath()` (resolve-tsconfig.ts, line 50) · written on first call, memoized

**Config Files:**
- `apigen.config.json` · optional projection-override file · loaded in `loadOverrideConfig()` (orchestrator, not in flagged files)
- `tsconfig.json` · discovered via walk-up from source dir, or explicit `--tsconfig` flag · used to resolve module paths and type info
- `default-tsconfig.json` · shipped asset beside the bundled CLI entry, or fallback inline constant written to a temp file

**How Scope/Paths Decided Today:**
- Output directory is explicit CLI flag (`--out-dir <path>`), resolved to absolute via `path.resolve()`
- Temp fallback tsconfig written to system `os.tmpdir()` with auto-generated subdir; memoized to prevent repeated temp creations
- All paths are absolute or cwd-relative; no $HOME, XDG, or `.adhd` cascade
- Config file lookup is walk-up from source (tsconfig) or explicit flag; no `.adhd` scope marker discovery

## Proposed `EnvironmentSpec`

```typescript
const apigenCliSpec = {
  fields: {
    logLevel: {
      type: 'string',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
      default: 'info',
      env: 'APIGEN_LOG_LEVEL',
      at: 'runtime',
    },
    logFormat: {
      type: 'string',
      enum: ['json', 'pretty'],
      env: 'APIGEN_LOG_FORMAT',
      at: 'runtime',
    },
    pythonOverride: {
      type: 'string',
      env: 'ADHD_APIGEN_CLI_PYTHON',
      secret: true,
      at: 'runtime',
      description: 'Absolute path to Python interpreter; APIGEN_PYTHON prefix will be remapped',
    },
  },
  dirs: {
    logs: {
      kind: 'logs',
      share: 'per-instance',
    },
    generatedOutput: {
      kind: 'data',
      share: 'per-instance',
    },
    cache: {
      kind: 'cache',
    },
  },
  files: {
    projectionConfig: {
      in: 'generatedOutput',
      name: 'apigen.config.json',
    },
  },
  envPrefixOverride: 'ADHD_APIGEN_CLI',
} as const satisfies EnvironmentSpec<ApigenCliConfig>;
```

## Gap Detail

1. **G1** — `APIGEN_PYTHON` env var name does not follow `ADHD_<PROJECT>_*` prefix convention (line 1250, serve.ts). Remapping required when adopting; existing scripts/usage need migration path.
2. **G2** — Builtin default tsconfig written to `os.tmpdir()/apigen-tsconfig-*` (line 50, resolve-tsconfig.ts), which is outside the `@adhd/environment` scope hierarchy (`~/.adhd/…` or `./.adhd/…`). Should be moved to a stable cache/config directory under `env.paths.cache` or `env.paths.config`.
3. **G4** — Multi-file config: `apigen.config.json` (projection overrides) + `tsconfig.json` (TypeScript compiler opts) + fallback `default-tsconfig.json` (builtin). Single-layer-file model requires explicit merging or flattening; walk-up discovery (tsconfig) is not expressible as a fixed FieldSpec.

## Logging Audit

**Mechanism:** Uses `pino` v10.3.1 (package.json line 15) via `createLogger()` from `@adhd/apigen-engine-runtime`. The logger is built in `buildCliLogger()` (logging.ts line 33) with level, format, and destination parameters.

**Destination:** stderr by default (typical pino behavior); custom file via `--log-file <path>` CLI flag or `APIGEN_LOG_FILE` env var, passed to `createLogger({ destination })`.

**Persistence:** Yes. Logs are written to a file when `APIGEN_LOG_FILE` is set or `--log-file` is provided. The file path is user-specified; there is no default log directory managed by the package.

**Structured:** Yes when `--log-format json` / `APIGEN_LOG_FORMAT=json`; plaintext (pretty format) when `--log-format pretty`.

**Error Handling:** Robust. The `createLogger()` call is wrapped; invalid log levels/formats are handled gracefully (rawFormat is validated before passing to createLogger). Logging calls in generate.ts and serve.ts are unconditional `logger.info()` calls with string templates; no try/catch around individual log statements, but the logger itself is designed to swallow emission errors.

**Benefit of `env.paths.logs`:** High. Currently, log files have no default directory — users must specify `--log-file` with an absolute path each time, or set `APIGEN_LOG_FILE` in a shell script/CI config. Adopting `env.paths.logs` (kind: 'logs', share: 'per-instance') would allow:
- Default log emission to `~/.adhd/apigen-cli/default/logs/<instance-id>.log` (or `./.adhd/apigen-cli/…` in project scope)
- Per-instance isolation (concurrent runs don't collide)
- Automatic cleanup/archival via env policies
- Unified observability (all apigen instances log to the same managed location)

---

## File-Location Table — Corrected to New Standard

| Current Path | Kind | New-Standard Path (global scope) | Env Accessor | Notes |
|---|---|---|---|---|
| `--out-dir` (user-specified) | data | `~/.adhd/apigen-cli/default/data/generated-output` | `env.paths.generatedOutput` | Currently user-explicit; adopting env allows shared default. |
| `--out-dir/package.json` | config | `~/.adhd/apigen-cli/default/data/generated-output/package.json` | `env.files.projectionConfig` | Scaffolding artifact; would be placed under generated output subdir. |
| `--out-dir/tsconfig.json` | config | `~/.adhd/apigen-cli/default/data/generated-output/tsconfig.json` | `env.paths.generatedOutput/<name>` | Module resolution scaffolding. |
| `--out-dir/node_modules` | data | `~/.adhd/apigen-cli/default/data/generated-output/node_modules` | `env.paths.generatedOutput/node_modules` | Symlink/copy dir for pre-publish local runs (via `--link-workspace`). |
| `os.tmpdir()/apigen-tsconfig-*` | cache | `~/.adhd/apigen-cli/default/cache/builtin-tsconfig.json` | `env.paths.cache/builtin-tsconfig.json` | Fallback builtin config; should be moved to a stable cache location. |
| `APIGEN_LOG_FILE` (custom user-specified path) | logs | `~/.adhd/apigen-cli/default/logs/apigen.log` | `env.paths.logs/<filename>` | Currently requires explicit --log-file or env var; env.paths.logs provides default and per-instance isolation. |
| `apigen.config.json` (walked up from source or explicit `--config`) | config | `~/.adhd/apigen-cli/default/config/apigen.config.json` | `env.files.projectionConfig` | Projection overrides; could be unified with project scope `.adhd/apigen-cli/default/config/apigen.config.json`. |

**Project-Scope Variant:**
When the active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`), the same subtree is rooted at `<projectRoot>/.adhd/apigen-cli/default/…` instead of `~/.adhd/apigen-cli/default/…`. This allows per-project generated outputs, caches, and logs to be stored alongside the source repo, with isolation from global installations.

Example: A monorepo using apigen to generate API stubs per package would place each package's output at `./.adhd/apigen-cli/pkg-a/data/generated-output` (namespace = `pkg-a`) instead of scattering outputs to tmp directories or requiring explicit per-package `--out-dir` flags.
