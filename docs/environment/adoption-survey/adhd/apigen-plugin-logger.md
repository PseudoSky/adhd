---
package: @adhd/apigen-plugin-logger
path: /Users/nix/dev/node/adhd/packages/apigen/apigen-plugin-logger
root: adhd
language: node
self_internal: true
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: "stderr (fd 2)", kind: logs, purpose: "default log output"}, {path: "opts.destination (arbitrary)", kind: logs, purpose: "optional file log destination"}]
config_files: []
logging:
  has_logging: true
  logger: pino
  persists_log_files: true
  log_destination: "stderr (default) or custom file path via opts.destination"
  structured: true
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2]
value: high
effort: high
recommend: adopt-after-gap
---

## Current state

**Environment variables read:** None. The plugin accepts all configuration via the `LoggerOptions` constructor parameter at instantiation time (line 100–135), not from env vars.

**Writes:**
- `stderr (fd 2)` · logs · Default output channel for all operation entry/exit/error log lines (pino destination 2)
- `opts.destination` (arbitrary string path, user-provided) · logs · Optional file destination when `LoggerOptions.destination` is set (lines 102–132); the path is unconstrained (could be absolute, relative, system-level like `/var/log`)

**Config files:** None. Configuration is entirely at instantiation time via a TypeScript object.

**Current scope/path behavior:** Hardcoded to stderr by default. If a file destination is specified via `opts.destination`, it is a free-form string passed at construction time with no scoping or validation. The code uses `mkdir: true` to auto-create parent directories (lines 118, 127).

---

## Proposed `EnvironmentSpec`

```typescript
import type { EnvironmentSpec } from '@adhd/environment';

export const loggerPluginSpec: EnvironmentSpec<LoggerConfig> = {
  config: {
    'log.level': {
      type: 'string',
      env: 'ADHD_APIGEN_PLUGIN_LOGGER_LOG_LEVEL',
      default: 'info',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
      description: 'pino log level',
    },
    'log.format': {
      type: 'string',
      env: 'ADHD_APIGEN_PLUGIN_LOGGER_LOG_FORMAT',
      enum: ['json', 'pretty', 'auto'],
      default: 'auto',
      description: 'Log output format. "auto": pretty if stderr is TTY, json otherwise',
      at: 'runtime',
    },
    'log.destination': {
      type: 'string',
      env: 'ADHD_APIGEN_PLUGIN_LOGGER_LOG_DESTINATION',
      default: undefined,
      description: 'Optional: filename in logs directory (e.g., "app.log"). Omit to write to stderr only.',
    },
  },
  dirs: {
    logs: {
      kind: 'logs',
      share: 'per-instance',
    },
  },
  files: {
    appLog: {
      in: 'logs',
      name: 'app.log',
    },
  },
};
```

**Consumer code (revised makeLoggerPlugin):**

```typescript
export function makeLoggerPlugin(
  opts: LoggerOptions = {},
  env?: Environment
): Plugin<LoggerOptions> {
  const _env = env ?? Environment.create(loggerPluginSpec);
  const config = _env.resolveConfig();

  const level = opts.level ?? config['log.level'] ?? 'info';
  const format = opts.format ?? config['log.format'] ?? 'auto';
  const destination =
    opts.destination ??
    (config['log.destination'] ? _env.files.appLog : undefined);

  const root = buildRootLogger({
    level,
    format: format === 'auto' ? undefined : format,
    destination,
  });

  return {
    ...loggerPlugin,
    capabilities: {
      ...loggerPlugin.capabilities,
      layer: { layer: makeLayer(root) },
    },
  };
}
```

---

## Gap detail

**G1** — The code reads `process.stderr.isTTY` (line 104) to auto-detect whether to use pretty or json format. This is a Node.js built-in property, not an env var, so `isEnvNameAllowed` cannot guard it. However, the proposed spec adds `'log.format': 'auto'` as the default, which preserves this behavior: the code checks TTY when format is not explicitly set. No blocking issue.

**G2** — `opts.destination` is a free-form string path with no constraint. User could specify `/var/log/app.log`, `/tmp/debug.log`, `../../sensitive`, or `./data` (repo-relative). @adhd/environment ensures all paths are scoped under `~/.adhd/<project>/<namespace>/logs/` and never escape (lines 102–132).

---

## Logging audit

**Has logging:** Yes. This package IS a logger plugin.

**Logger mechanism:** Pino (10.3.1 from package.json). The plugin wraps every apigen operation (unary and streaming) and logs entry (`→ op`), exit with duration (`← op ok`), and errors (`✗ op error`). Per-operation logger instances are seeded into `call.ctx` (lines 87–94) for downstream consumers.

**Persists log files:** Yes, optionally. By default logs go to stderr; if `opts.destination` is set, pino writes to that file path with `mkdir: true` (lines 118, 127).

**Log destination:**
- **Default:** stderr (fd 2), never stdout (which is the MCP stdio JSON-RPC channel per line 24).
- **Optional:** custom file path via `opts.destination` (unconstrained; could be absolute, relative, or system-level).

**Structured:** Yes. JSON by default (lines 131, 123–132). Pretty-printed (colorized, human-readable) if stderr is a TTY and no file destination is set (lines 108–122).

**Error handling:** Robust. Every operation invocation wraps the continuation in try/catch (streaming, lines 181–191) or .then()/.catch() (unary, lines 197–206). Errors are logged with context (`{ op, ms, err }`) and re-thrown per §8.1 rule 2 to unwind outward (lines 190, 204).

**Maps to env.paths.logs:** Yes. The current code accepts `opts.destination` at instantiation and cannot be overridden at runtime. Adopting `env.paths.logs` (kind:`logs`, `share:'per-instance'`) would:
- Provide a consistent, scoped location (`~/.adhd/apigen-plugin-logger/default/logs/app.log`).
- Support multi-instance isolation (each instance gets `~/.adhd/apigen-plugin-logger/<instance-id>/logs/app.log`).
- Allow project and global scope overrides via env.
- Eliminate free-form path vulnerability (G2).

---

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| stderr (fd 2) | logs | (stdout → no file) | direct to stderr (no change) |
| `opts.destination` (arbitrary file path) | logs | `~/.adhd/apigen-plugin-logger/default/logs/app.log` | `env.files.appLog` |

**Project scope variant:**
When `.git`/`.adhd` markers are detected or `ADHD_ENV_SCOPE=project` is set, paths root at `<projectRoot>/.adhd/apigen-plugin-logger/default/logs/…` instead.

**Per-instance variant:**
If multi-instance isolation is needed (concurrent runs), use `share: 'per-instance'` in the spec. Logs then go to `~/.adhd/apigen-plugin-logger/<instance-id>/logs/app.log` where `<instance-id>` is a UUID managed by the environment.

---

## Adoption notes

**Why adopt:**
1. **Path safety:** Free-form `opts.destination` is eliminated. All writes go under scoped `~/.adhd/apigen-plugin-logger/<namespace>/logs/`.
2. **Env tunability:** Log level, format, and destination become configurable via env vars (`ADHD_APIGEN_PLUGIN_LOGGER_LOG_LEVEL=debug`) without code changes or CLI flags.
3. **Multi-instance safety:** `share: 'per-instance'` provides automatic log isolation for concurrent apigen runs.
4. **Consistency:** Aligns with apigen's broader config cascade (code default → system → global → project → local → env).

**Implementation:** Moderate effort. Pass an `Environment` instance to `makeLoggerPlugin()` (or let it create one), then resolve the config keys (`log.level`, `log.format`, `log.destination`) from the cascade before calling `buildRootLogger()`. The destination argument changes from a string to a file path from `env.files.appLog`.
