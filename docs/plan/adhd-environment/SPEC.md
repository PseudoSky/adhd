# @adhd/environment — Implementation Spec

Produced by the architect agent on 2026-07-01.

## Summary

Extract the reusable configuration infrastructure from `@adhd/agent-mcp`'s `config.ts` and `load-env.ts` into a new `@adhd/environment` shared package (`platform:shared`, `layer:shared`). The package provides a `Configuration` class that handles scoped path resolution (project/global/system), `.env` hierarchy loading, env-var-over-default resolution, and Zod validation. Agent-mcp retains its domain-specific dynamic methods (provider resolution, env-ref security) while delegating static field management to `Configuration`. Other packages (agent-compiler, agent-mcp-budget) gain a consistent config surface.

## Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/environment/package.json` | create | 0 | 250 |
| `packages/environment/project.json` | create | 0 | 600 |
| `packages/environment/tsconfig.json` | create | 0 | 100 |
| `packages/environment/tsconfig.lib.json` | create | 0 | 100 |
| `packages/environment/vite.config.ts` | create | 0 | 400 |
| `packages/environment/src/index.ts` | create | 0 | 150 |
| `packages/environment/src/lib/configuration.ts` | create | 0 | 800 |
| `packages/environment/src/lib/paths.ts` | create | 0 | 300 |
| `packages/environment/src/lib/load-env.ts` | create | 0 | 200 |
| `packages/ai/agent-mcp/src/config.ts` | modify | 394 | 400 |
| `packages/ai/agent-mcp/src/utils/load-env.ts` | modify | 27 | 20 |
| `packages/ai/agent-mcp/package.json` | modify | 60 | 70 |
| `packages/ai/agent-compiler/src/db/client.ts` | modify | 40 | 50 |
| `packages/ai/agent-compiler/src/cli/compile.ts` | modify | 40 | 45 |

## Interface changes

### New: `packages/environment/src/index.ts`

```typescript
export { Configuration } from './lib/configuration.js';
export type { ConfigScope, FieldDefinition, ConfigurationOptions } from './lib/configuration.js';
export { resolvePath } from './lib/paths.js';
export { loadEnvHierarchy } from './lib/load-env.js';
```

### New: `packages/environment/src/lib/configuration.ts`

```typescript
export type ConfigScope = 'project' | 'global' | 'system';

export interface FieldDefinition {
  /** Which directory scope governs the default value */
  scope: ConfigScope;
  /** Default value (relative path for project, ~-prefixed for global/system) */
  default: string;
}

export interface ConfigurationOptions {
  /** Organisation namespace (e.g. "adhd") — used for global/system path roots */
  org: string;
  /** Package namespace (e.g. "agent-mcp") — used for path nesting */
  namespace: string;
  /** Field name → { scope, default } definitions */
  fields: Record<string, FieldDefinition>;
  /** Optional: field name → env-var NAME mapping */
  env?: Record<string, string>;
}

export class Configuration {
  constructor(readonly options: ConfigurationOptions);

  /** Resolve a single field — returns the scoped path (no env lookup by default). */
  resolvePath(field: string, cwd?: string): string;

  /** Resolve a single field through env var → cfg file → default. */
  resolve(field: string, envSnapshot?: Record<string, string | undefined>, cwd?: string): string;

  /** Resolve all fields defined in `fields` into a plain key→value object. */
  resolveAll(envSnapshot?: Record<string, string | undefined>, cwd?: string): Record<string, string>;

  /** Resolve all fields and validate through a Zod schema. Returns the parsed/coerced type. */
  validate<T>(schema: Zod.ZodType<T>, envSnapshot?: Record<string, string | undefined>, cwd?: string): T;
}
```

### New: `packages/environment/src/lib/paths.ts`

```typescript
export const CONFIG_SCOPES = {
  /** Resolves relative to CWD (defaults os.homedir() fallback). */
  project: (relPath: string, cwd?: string) => string;
  /** Resolves under ~/.adhd/ (XDG-style). */
  global:  (relPath: string) => string;
  /** Resolves under /etc/adhd/ (platform-safe; /etc only on POSIX, throws on Windows). */
  system:  (relPath: string) => string;
};

/**
 * Resolve a scoped path: expands ~, applies scope base, joins.
 * `~` prefix in the default value is always expanded to os.homedir().
 */
export function resolvePath(scope: ConfigScope, defaultPath: string, org: string, cwd?: string): string;
```

### New: `packages/environment/src/lib/load-env.ts`

```typescript
/**
 * Load `.env` hierarchy into `process.env`. Most-specific wins:
 *   1. ~/.adhd/.env            (lowest precedence, loaded first, no override)
 *   2. <cwd>/.adhd/.env        (project .adhd)
 *   3. <cwd>/.env               (highest precedence)
 *
 * Each file skipped if absent. Call once at startup.
 * Requires `dotenv` as a peer dependency (package does not bundle it —
 * callers already have it or can add it).
 */
export function loadEnvHierarchy(cwd?: string): void;
```

### `packages/ai/agent-mcp/src/config.ts` — loadConfig()

**BEFORE:**
```typescript
import { loadEnvHierarchy } from "./utils/load-env.js";
// … local deepFreeze, rawFromEnv, configSchema, PROVIDER_DEFAULTS, normalizeBaseUrl, isLocalhostUrl …

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = configSchema.parse(rawFromEnv(env));
    // … dynamic methods building …
}
```

**AFTER:**
```typescript
import { Configuration, loadEnvHierarchy } from "@adhd/environment";
// … retain: PROVIDER_DEFAULTS, normalizeBaseUrl, isLocalhostUrl, deepFreeze …

// Static fields delegated to Configuration
const agentMcpConfig = new Configuration({
    org: "adhd",
    namespace: "agent-mcp",
    fields: {
        "db-path":              { scope: "global", default: "~/.adhd/agent-mcp/agents.db" },
        "log-level":            { scope: "global", default: "info" },
        "queue-concurrency":    { scope: "global", default: "5" },
        "server-max-depth":     { scope: "global", default: "5" },
        "server-max-tool-loops": { scope: "global", default: "50" },
        // ... etc.
    },
    env: {
        "db-path":              "ADHD_AGENT_DATABASE_PATH",
        "log-level":            "ADHD_AGENT_LOG_LEVEL",
        // ... etc.
    },
});

// loadConfig now uses Configuration.validate() for static fields, then
// builds dynamic methods on top of the resolved + validated snapshot.
```

### `packages/ai/agent-mcp/src/utils/load-env.ts`

**BEFORE:**
```typescript
export function loadEnvHierarchy(cwd: string = process.cwd()): void { ... }
```

**AFTER:**
```typescript
// Re-export from @adhd/environment for backward compatibility
export { loadEnvHierarchy } from "@adhd/environment";
```

### `packages/ai/agent-compiler/src/db/client.ts`

**BEFORE:**
```typescript
const databasePath =
  process.env['REGISTRY_DATABASE_PATH'] ||
  process.env['DATABASE_PATH'] ||
  './data/registry.db';
```

**AFTER:**
```typescript
import { Configuration } from "@adhd/environment";
const compilerConfig = new Configuration({
    org: "adhd", namespace: "agent-compiler",
    fields: { "db-path": { scope: "project", default: "./data/registry.db" } },
    env: { "db-path": "REGISTRY_DATABASE_PATH" },
});
const databasePath = compilerConfig.resolve("db-path");
```

## Behavioral changes

### `packages/environment/src/lib/paths.ts` — resolvePath()

- **Change:** New function. Expands `~` prefix to `os.homedir()`.
- **scope=project:** joins `cwd` (default `process.cwd()`) with `default`.
- **scope=global:** joins `os.homedir()/.adhd/` with `default` (after `~` expansion).
- **scope=system:** joins `/etc/adhd/` with `default`. On non-POSIX, throws a descriptive error.
- **`~` handling:** `~` prefix anywhere is expanded; paths already absolute are returned as-is.
- **No fs operations** — this is pure path math.

### `packages/environment/src/lib/configuration.ts` — Configuration

- **Change:** New class. Constructor takes `ConfigurationOptions` and stores them.
- **`resolvePath(field)`:** looks up `fields[field]`, calls `resolvePath(scope, default, org, cwd)`. Returns the resolved absolute path. **Does NOT read env vars.**
- **`resolve(field, envSnapshot?, cwd?)`:** checks `envSnapshot?.[envVarName]` first (where `envVarName` comes from `options.env[field]`), falls back to `resolvePath(field, cwd)`. If env var is set, its value is used verbatim (not re-resolved through scoping).
- **`resolveAll(envSnapshot?, cwd?)`:** iterates all `fields` keys, calling `resolve()` for each. Returns `Record<string, string>`.
- **`validate(schema, envSnapshot?, cwd?)`:** calls `resolveAll()`, passes result through `schema.parse()`. Returns the Zod-inferred type. Fails fast on invalid input.
- **Zod is NOT bundled** — it's a peer dependency. The `validate()` method dynamically calls `schema.parse()`. TypeScript generics capture the output type.

### `packages/ai/agent-mcp/src/config.ts` — loadConfig()

- **Change:** Static field resolution (db path, logging level, queue/server/sse/transport/plugins config) now goes through `Configuration.validate()` with the existing Zod schema.
- **Provider defaults, env-ref security, dynamic methods (`getProviderConfig`, `resolveEnvRef`, `isEnvNameAllowed`, `verifyEnvRefs`, `subprocessEnv`)** stay in `config.ts` unchanged.
- **`deepFreeze` is retained** as a local helper (it freezes dynamic methods, not just static objects).
- **Module-load side effect** (`loadEnvHierarchy()` on line 26) now calls the re-export from `@adhd/environment`.
- **Imports:** remove `import { loadEnvHierarchy } from "./utils/load-env.js"`, replace with `import { Configuration, loadEnvHierarchy } from "@adhd/environment"`.

### `packages/ai/agent-mcp/src/utils/load-env.ts`

- **Change:** Becomes a thin re-export of `@adhd/environment`'s `loadEnvHierarchy`. Exists for backward compatibility — other files may import from the old path.
- **No functional change** — the re-export preserves the existing call signature.

### `packages/ai/agent-compiler/src/db/client.ts`

- **Change:** Ad-hoc `REGISTRY_DATABASE_PATH || DATABASE_PATH || './data/registry.db'` replaced with a `Configuration` instance. Falls back to `REGISTRY_DATABASE_PATH` env var, then `DATABASE_PATH`, then scoped default `./data/registry.db`.
- **Path resolution:** The `./data/registry.db` default resolves relative to CWD via `scope: "project"` — same as current `path.resolve(databasePath)` behavior.
- **Never touch:** SQLite handle creation, WAL pragma, drizzle setup.

## Independent segments

### Segment A: Package scaffolding

- **Files:** `packages/environment/package.json`, `project.json`, `tsconfig.json`, `tsconfig.lib.json`, `vite.config.ts`
- **Dependencies:** none
- **Read tokens:** 0 (new files with reference to transform/package.json + transform/vite.config.ts)
- **Output tokens:** ~1,450
- **Required context:** Copy structure from `packages/transform/` as template; set tags to `["platform:shared", "layer:shared"]`; package name `@adhd/environment`; peerDependency on `dotenv`, `zod`; `type: "module"`

### Segment B: Core library — paths.ts + load-env.ts

- **Files:** `packages/environment/src/lib/paths.ts` (create), `packages/environment/src/lib/load-env.ts` (create)
- **Dependencies:** none (pure Node stdlib: `path`, `os`)
- **Read tokens:** ~200 (existing load-env.ts for migration reference)
- **Output tokens:** ~500
- **Required context:** Read `packages/ai/agent-mcp/src/utils/load-env.ts` lines 1-27 ONLY.

### Segment C: Core library — configuration.ts + index.ts

- **Files:** `packages/environment/src/lib/configuration.ts` (create), `packages/environment/src/index.ts` (create)
- **Dependencies:** Segment B (imports `resolvePath` from paths.ts and `loadEnvHierarchy` from load-env.ts)
- **Read tokens:** 0 (standalone new code)
- **Output tokens:** ~950
- **Required context:** Understand the `ConfigurationOptions` interface and class shape shown above. No codebase reads needed.

### Segment D: agent-mcp migration

- **Files:** `packages/ai/agent-mcp/src/config.ts` (modify), `packages/ai/agent-mcp/src/utils/load-env.ts` (modify), `packages/ai/agent-mcp/package.json` (modify)
- **Dependencies:** Segments A–C (package must be built/available for import)
- **Read tokens:** ~450 (config.ts lines 1-30 for imports + lines 153-390 for deepFreeze/rawFromEnv/schema/factory; load-env.ts full; package.json full)
- **Output tokens:** ~490
- **Required context:** Read `packages/ai/agent-mcp/src/config.ts` lines 1-27 (imports + load call), lines 153-165 (deepFreeze), lines 168-252 (rawFromEnv + schema), lines 256-261 (loadConfig signature), lines 262-390 (factory body showing what dynamic methods need). Do NOT read provider-specific methods (lines 292-360) in depth — they stay.

### Segment E: agent-compiler migration

- **Files:** `packages/ai/agent-compiler/src/db/client.ts` (modify), `packages/ai/agent-compiler/src/cli/compile.ts` (modify)
- **Dependencies:** Segments A–C
- **Read tokens:** ~80
- **Output tokens:** ~95
- **Required context:** Read `packages/ai/agent-compiler/src/db/client.ts` lines 1-30 ONLY.

## Execution strategies

### Segment A — Package scaffolding

1. Create directory `packages/environment/`.
2. Write `package.json` — name `@adhd/environment`, version `0.1.0`, `type: "module"`, `private: false`, `publishConfig: { access: "public" }`. peerDependencies: `{ "dotenv": ">=17.0.0", "zod": ">=3.0.0" }`. main/module/typings as in transform.
3. Write `project.json` — copy from `packages/transform/project.json`, change name to `environment`, paths to `packages/environment`, tags to `["platform:shared", "layer:shared"]`.
4. Write `tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" }, "files": [], "include": [], "references": [{ "path": "./tsconfig.lib.json" }] }`.
5. Write `tsconfig.lib.json` — extends `./tsconfig.json`, outDir `../../dist/out-tsc`, types `["node"]`, include `src/**/*.ts`, exclude `vite.config.ts`, `src/**/*.spec.ts`, `src/**/*.test.ts`.
6. Write `vite.config.ts` — copy from `packages/transform/vite.config.ts`, change paths to `packages/environment`, external: `["dotenv", "zod"]` in rollupOptions.

### Segment B — paths.ts + load-env.ts

1. Create `packages/environment/src/lib/paths.ts`.
2. Implement `resolvePath(scope, defaultPath, org, cwd?)`:
   - Expand `~` prefix: if `defaultPath.startsWith('~')`, replace with `os.homedir()`.
   - `scope === 'project'`: return `path.resolve(cwd ?? process.cwd(), expanded)`.
   - `scope === 'global'`: return `path.resolve(os.homedir(), '.adhd', expanded.replace(/^~/, '').replace(/^\//, ''))`.
   - `scope === 'system'`: if platform is not POSIX, throw `new Error("System-scoped config is not supported on this platform")`. Return `path.join('/etc', 'adhd', expanded.replace(/^~/, '').replace(/^\//, ''))`.
   - All path math — no fs calls.
3. Create `packages/environment/src/lib/load-env.ts`.
4. Copy the existing `loadEnvHierarchy` function from `packages/ai/agent-mcp/src/utils/load-env.ts`. Import `dotenv` as the `config` named export. Same 3-step hierarchy. No other changes.
5. NEVER: add file I/O, config file discovery, or any logic beyond the existing 3-step dotenv chain.

### Segment C — configuration.ts + index.ts

1. Create `packages/environment/src/lib/configuration.ts`.
2. Define `ConfigScope`, `FieldDefinition`, `ConfigurationOptions` types as shown in Interface changes.
3. Implement `Configuration` class:
   - Constructor stores `this.options = options`. No work done at construction time.
   - `resolvePath(field, cwd?)`: lookup `this.options.fields[field]`, call `resolvePath(def.scope, def.default, this.options.org, cwd)` from paths.ts. Throw if field not found.
   - `resolve(field, envSnapshot?, cwd?)`: if `envSnapshot` is provided and `this.options.env?.[field]` exists, check `envSnapshot[envVarName]`. If non-undefined, return it verbatim (string). Otherwise call `resolvePath()`.
   - `resolveAll(envSnapshot?, cwd?)`: `Object.keys(this.options.fields).reduce(...)` calling `resolve` for each.
   - `validate(schema, envSnapshot?, cwd?)`: `return schema.parse(this.resolveAll(envSnapshot, cwd))`.
   - NO deepFreeze in this class — that's caller's responsibility. This is a pure resolver.
4. Create `packages/environment/src/index.ts` with re-exports.
5. NEVER: bundle Zod, freeze objects, call `dotenv`, or add any agent-mcp-specific logic.

### Segment D — agent-mcp migration

1. Read `packages/ai/agent-mcp/src/config.ts` lines 1-27 to see imports and `loadEnvHierarchy()` call.
2. Replace import: `import { loadEnvHierarchy } from "./utils/load-env.js"` → `import { Configuration, loadEnvHierarchy } from "@adhd/environment"`.
3. Add `import { z } from "zod"` if not already present (it is).
4. Between the `loadEnvHierarchy()` call and the type definitions, insert a `Configuration` instance (see full field list in Behavioral changes)
5. In `loadConfig(env)`: replace `const parsed = configSchema.parse(rawFromEnv(env))` with `const parsed = agentMcpConfig.validate(configSchema, env)`.
6. Remove the now-unused `rawFromEnv` function (lines 168-198).
7. For `packages/ai/agent-mcp/package.json`: add `"@adhd/environment": "0.1.0"` to dependencies.
8. For `packages/ai/agent-mcp/src/utils/load-env.ts`: replace body with `export { loadEnvHierarchy } from "@adhd/environment";`. Remove dotenv import.
9. NEVER: touch `getProviderConfig`, `resolveEnvRef`, `isEnvNameAllowed`, `verifyEnvRefs`, `subprocessEnv`, the `Config` interface shape, or any test file.

### Segment E — agent-compiler migration

1. Read `packages/ai/agent-compiler/src/db/client.ts` lines 1-30 ONLY.
2. Add import: `import { Configuration } from "@adhd/environment";` at line 6.
3. Insert Configuration instance and replace the ad-hoc `databasePath` assignment.
4. For `packages/ai/agent-compiler/src/cli/compile.ts`: replace the `dbPath` assignment similarly.
5. NEVER: touch SQLite handle, WAL pragma, drizzle setup, or export statements.

## Test cases

### Unit tests (packages/environment/src/lib/configuration.spec.ts)

- `resolvePath("db-path")` with scope=global → resolves to `~/.adhd/agent-mcp/agents.db`
- `resolvePath("db-path")` with scope=project → resolves relative to CWD
- `resolvePath("db-path")` with scope=system → throws on non-POSIX
- `resolve("db-path", { ADHD_AGENT_DATABASE_PATH: "/custom/db" })` → env wins
- `resolve("db-path", {})` → falls back to scoped default
- `resolveAll(envSnapshot)` → returns all fields
- `validate(zodSchema, envSnapshot)` → returns parsed type
- `resolve("nonexistent")` → throws
- `loadEnvHierarchy()` → loads in correct order
- `resolvePath` with `~` → expands to homedir
- `resolvePath` with absolute path → returned as-is

### Migration tests

- Existing `loadConfig(fakeEnv)` tests continue to pass identically
- All config assertions produce the same values as before migration

## Edge cases

- **Windows:** scope=system throws. Path resolution works (Node path handles it).
- **Missing env var:** Falls through to Configuration default, then Zod default.
- **Empty string env var:** Treated as set (not undefined). Fails Zod validation rather than silently using default.
- **`~` in env values:** NOT expanded — only defaults undergo `~` expansion.
- **Multiple packages:** Each Configuration is independent. Namespace isolation is by convention (package authors prefix their env vars).
- **`loadEnvHierarchy()` called multiple times:** Harmless — dotenv's `override: true` means re-calling is a no-op.

## Documentation updates

- `packages/environment/README.md` — API reference
- `packages/ai/agent-mcp/CLAUDE.md` — update `.env` loading section
- `BACKLOG.md` — note `DATABASE_PATH` legacy fallback removed from agent-compiler
