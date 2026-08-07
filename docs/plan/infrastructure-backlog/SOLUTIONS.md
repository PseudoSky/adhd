# Infrastructure Backlog — Solutions Specification

> Generated: 2026-07-04 | Spec revision: 1  
> 6 items scoped from the infrastructure backlog. For each: file paths, interface changes (BEFORE/AFTER), behavioral changes, independent segments, test cases, and edge cases.

---

## NB-1: agent-store-prompts typecheck fails (14 TS6306 errors)

**Root cause:** `tsconfig.json` has `"module": "commonjs"` (conflicts with the package's `"type": "module"` and ESM source files), uses `"references"` to `tsconfig.lib.json`, and has `"files": []`. The `typecheck` target (`tsc -p tsconfig.json --noEmit`) processes this root config with `commonjs` module, causing TS6306 on every import that resolves to an ESM module.

**Fix strategy:** Match `agent-engine-compiler`'s `tsconfig.json` pattern exactly — ESNext + Bundler + noEmit, no project references, no `files: []`.

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/agent/agent-store-prompts/tsconfig.json` | modify | 100 | 80 |
| `packages/agent/agent-store-prompts/tsconfig.lib.json` | modify | 70 | 30 |

### Interface changes

#### `packages/agent/agent-store-prompts/tsconfig.json`

```jsonc
// BEFORE
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "files": [],
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts"],
  "references": [
    { "path": "./tsconfig.lib.json" }
  ]
}

// AFTER
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

#### `packages/agent/agent-store-prompts/tsconfig.lib.json`

```jsonc
// BEFORE — extends "./tsconfig.json" which has "module": "commonjs" and "references"
// AFTER — remove the conflict with the parent; tsconfig.lib.json already has correct ESNext settings.
// The extends chain is: tsconfig.lib.json → tsconfig.json → tsconfig.base.json.
// After fixing tsconfig.json, the chain works correctly with no changes needed to tsconfig.lib.json.
// BUT: tsconfig.json no longer has "references" so the extends relationship is clean.
```

**No changes needed** to `tsconfig.lib.json` — it already sets `"module": "ESNext"`, `"moduleResolution": "Bundler"`, and correct `outDir`/`rootDir`. The fix in `tsconfig.json` removes the `"module": "commonjs"` conflict and `"references"` that caused TS6306.

### Behavioral changes

- **Before:** `tsconfig.json` declares `"module": "commonjs"` (overriding base's `"module": "esnext"`), uses project `"references"` to `tsconfig.lib.json`, and has `"files": []`. The `typecheck` target runs `tsc -p tsconfig.json --noEmit` which uses the root config with `commonjs` module, producing 14 TS6306 errors because source files use ESM syntax.
- **After:** `tsconfig.json` matches `agent-engine-compiler`'s pattern — `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"noEmit": true`, no `"references"`, no `"files": []`. The `typecheck` target runs cleanly because the root config is now ESM-compatible.
- **Build target unaffected:** `tsconfig.lib.json` is used for the build (via `project.json` build options), not `tsconfig.json`. The build config remains ESNext + Bundler + `noEmit: false`.
- **Invariant preserved:** The `tsconfig.lib.json` is ONLY for the nx build; `tsconfig.json` is ONLY for the typecheck command. They serve different purposes and don't share settings.

### Independent segments

#### Segment A: Rewrite tsconfig.json

- **Files:** `packages/agent/agent-store-prompts/tsconfig.json` (entire file, 20 lines)
- **Dependencies:** none
- **Read tokens:** 100 — read the current file + agent-engine-compiler's tsconfig.json for reference
- **Output tokens:** 80 — replace 20 lines with ~20 lines
- **Required context:** agent-engine-compiler's `tsconfig.json` (already analyzed) as the pattern template.

### Execution strategy — Segment A

1. Read `packages/agent/agent-engine-compiler/tsconfig.json` (already analyzed — use as template).
2. Copy compilerOptions block exactly from agent-engine-compiler to agent-store-prompts.
3. **Key differences to preserve:**
   - agent-store-prompts does NOT need `"vitest/globals"` in `"types"` — tests use vitest imports directly, not globals. Keep `"types": ["node"]`.
   - agent-store-prompts does NOT include test files in the root tsconfig (test files have their own `tsconfig.spec.json`).
4. Remove `"files": []`, `"exclude"`, and `"references"` blocks.
5. Keep `"include": ["src/**/*.ts"]`.
6. Verify: `npx nx typecheck agent-store-prompts` → EXIT 0 with zero TS6306 errors.

### Test cases

1. `npx nx typecheck agent-store-prompts` → EXIT 0 (was 14 TS6306 errors)
2. `npx nx build agent-store-prompts` → EXIT 0 (build must not regress — build uses tsconfig.lib.json)
3. `npx nx test agent-store-prompts` → EXIT 0 (tests resolve through their own vite config)
4. TS6306 count = 0 in typecheck output

### Edge cases

- **tsconfig.base.json has `"module": "esnext"` (lowercase).** The child override `"module": "ESNext"` takes precedence. No conflict.
- **tsconfig.base.json has `"lib": ["es2020", "dom"]`.** The child override `"lib": ["ES2022"]` takes precedence. The `"dom"` lib from base is irrelevant for a Node package but harmless.
- **build target references `tsconfig.lib.json`.** Unaffected — the build executor reads `tsConfig` from project.json build options, not `tsconfig.json`.

---

## DEBT-CLI-001: Symlink workaround in agent-engine-compiler test

**Root cause:** The `compile-cli.test.ts` test spawns the built CLI bin (`dist/packages/agent/agent-engine-compiler/src/cli/compile.js`) as a child process. Node's ESM resolution walks up from the bin's directory looking for `node_modules/@adhd/<pkg>` to resolve `@adhd/*` imports. Since the dist directory has no `node_modules`, the test creates symlinks in `beforeAll` (lines 205–225) pointing each `@adhd` dep to its dist counterpart, then removes them in `afterAll` (lines 332–337). This is fragile, workspace-layout-dependent, and a known antipattern (memory: "symlink-hack-antipattern").

**Fix strategy:** Add `"generatePackageJson": true` to the build options in `project.json`. When `@nx/js:tsc` builds with this option, it generates a `package.json` in the output directory listing the package's dependencies. The test then sets `NODE_PATH` to the repo root (or the dist root) so Node resolution finds the workspace packages through the monorepo's `node_modules` rather than hand-crafted symlinks.

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/agent/agent-engine-compiler/project.json` | modify | 30 | 20 |
| `packages/agent/agent-engine-compiler/src/__tests__/compile-cli.test.ts` | modify | 200 | 60 |

### Interface changes

#### `packages/agent/agent-engine-compiler/project.json` — build options

```jsonc
// BEFORE (lines 16-31)
"build": {
  "executor": "@nx/js:tsc",
  "outputs": ["{options.outputPath}"],
  "options": {
    "outputPath": "dist/packages/agent/agent-engine-compiler",
    "main": "packages/agent/agent-engine-compiler/src/index.ts",
    "tsConfig": "packages/agent/agent-engine-compiler/tsconfig.lib.json",
    "clean": true,
    "assets": [
      {
        "input": "packages/agent/agent-engine-compiler",
        "glob": "drizzle/**/*",
        "output": "."
      }
    ]
  }
}

// AFTER — add "generatePackageJson": true
"build": {
  "executor": "@nx/js:tsc",
  "outputs": ["{options.outputPath}"],
  "options": {
    "outputPath": "dist/packages/agent/agent-engine-compiler",
    "main": "packages/agent/agent-engine-compiler/src/index.ts",
    "tsConfig": "packages/agent/agent-engine-compiler/tsconfig.lib.json",
    "clean": true,
    "generatePackageJson": true,
    "assets": [
      {
        "input": "packages/agent/agent-engine-compiler",
        "glob": "drizzle/**/*",
        "output": "."
      }
    ]
  }
}
```

#### `packages/agent/agent-engine-compiler/src/__tests__/compile-cli.test.ts` — beforeAll/afterAll

**BEFORE** (lines 205–225 — symlink creation in beforeAll):
```typescript
// ── 2. Create @adhd symlinks so the bin resolves its ESM imports ──────
fs.mkdirSync(ADHD_NM_DIR, { recursive: true });
for (const [name, target] of Object.entries(ADHD_DIST_DEPS)) {
  const linkPath = path.join(ADHD_NM_DIR, name);
  if (fs.existsSync(target)) {
    try {
      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      /* Non-fatal */
    }
  }
}
```

**AFTER:**
```typescript
// ── 2. Set NODE_PATH so the spawned bin resolves workspace packages ──
// With generatePackageJson:true, the dist/package.json lists @adhd/*
// deps. Node resolution finds them through the repo's node_modules
// via NODE_PATH. No manual symlinks needed.
const NODE_PATH = path.join(REPO_ROOT, 'node_modules');
```

**BEFORE** (lines 332–337 — symlink cleanup in afterAll):
```typescript
// Remove @adhd symlinks created in beforeAll.
try {
  fs.rmSync(ADHD_NM_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}
```

**AFTER:**
```typescript
// No symlinks to clean up — NODE_PATH is per-spawn, not persisted.
```

**BEFORE** (line 158–168 — spawnBin uses default env):
```typescript
function spawnBin(args: string[]): { ... } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
```

**AFTER** — inject NODE_PATH:
```typescript
function spawnBin(args: string[]): { ... } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_PATH: NODE_PATH,
    },
  });
```

**Remove** dead constants (lines 110–119):
```typescript
// REMOVE:
const ADHD_DIST_DEPS: Record<string, string> = {
  'agent-store-prompts': path.join(DIST_ROOT, 'agent/agent-store-prompts'),
  'agent-store-tools': path.join(DIST_ROOT, 'agent/agent-store-tools'),
  'agent-core-provider': path.join(DIST_ROOT, 'agent/agent-core-provider'),
  'agent-core-policy': path.join(DIST_ROOT, 'agent/agent-core-policy'),
  'agent-base-types': path.join(DIST_ROOT, 'agent/agent-base-types'),
};
const ADHD_NM_DIR = path.join(COMPILER_DIST, 'node_modules', '@adhd');
```

### Behavioral changes

- **Before:** The test manually creates symlinks in `dist/packages/agent/agent-engine-compiler/node_modules/@adhd/` pointing to dist packages. This couples the test to the exact dist layout and workspace structure.
- **After:** The build generates a `package.json` in dist. The test sets `NODE_PATH` to the repo root's `node_modules/` (where pnpm's workspace symlinks already exist). Node resolution handles the rest natively.
- **No change to spawn behavior:** The bin resolves imports identically — just through NODE_PATH instead of directory-adjacent symlinks.
- **Cleaner teardown:** No `fs.rmSync` of symlink directories needed in `afterAll`.

### Independent segments

#### Segment A: project.json build config

- **Files:** `packages/agent/agent-engine-compiler/project.json` (line 19)
- **Dependencies:** none
- **Read tokens:** 30
- **Output tokens:** 20 — add one line
- **Required context:** Read lines 16-31 of `project.json` to see the exact insertion point.

#### Segment B: compile-cli.test.ts — remove symlinks

- **Files:** `packages/agent/agent-engine-compiler/src/__tests__/compile-cli.test.ts` (lines 106-119, 158-168, 205-225, 332-337)
- **Dependencies:** Segment A (build must produce package.json first)
- **Read tokens:** 200 — read the symlink sections + spawnBin + constant declarations
- **Output tokens:** 60 — replace symlink code with NODE_PATH approach, delete dead constants
- **Required context:** Read lines 100-170 and 205-225 and 330-340 of the test file.

### Execution strategies

#### Segment A — project.json

1. Read `packages/agent/agent-engine-compiler/project.json` lines 16-31.
2. Insert `"generatePackageJson": true,` on a new line after `"clean": true,` (line 23).
3. NEVER modify: `outputPath`, `main`, `tsConfig`, `assets`, or any other build option.
4. Verify: `npx nx build agent-engine-compiler` → EXIT 0, and `dist/packages/agent/agent-engine-compiler/package.json` exists.

#### Segment B — compile-cli.test.ts

1. Read `packages/agent/agent-engine-compiler/src/__tests__/compile-cli.test.ts` lines 100-170.
2. Add `const NODE_PATH = path.join(REPO_ROOT, 'node_modules');` after the existing constant declarations.
3. Delete the `ADHD_DIST_DEPS` constant (lines 110-116) and `ADHD_NM_DIR` constant (line 119).
4. Modify `spawnBin` (lines 158-168) — add `env: { ...process.env, NODE_PATH: NODE_PATH }` to the spawnSync options.
5. Read lines 200-230 (the "2. Create @adhd symlinks" block in beforeAll).
6. Replace the entire symlink block with the one-line comment shown in "Interface changes".
7. Read lines 330-340 (the symlink cleanup in afterAll).
8. Replace the symlink cleanup with the one-line comment shown in "Interface changes".
9. NEVER modify: DB setup, seeding, test assertions, or any code outside the specified line ranges.

### Test cases

1. `npx nx build agent-engine-compiler` → EXIT 0, `dist/packages/agent/agent-engine-compiler/package.json` exists
2. Generated `package.json` in dist contains correct `name`, `type: "module"`, and `dependencies`
3. `npx nx test agent-engine-compiler` → EXIT 0, all 8 tests pass
4. The test spawns the bin successfully — bin resolves `@adhd/*` imports via NODE_PATH
5. `afterAll` completes without errors (no symlinks to clean up)

### Edge cases

- **NODE_PATH pointing to repo root node_modules**: pnpm's workspace symlinks live there. If `node_modules/.pnpm` structure is used, NODE_PATH must point to the hoisted `.pnpm` root instead. Verify after `generatePackageJson`: the generated package.json's dependency entries match what's resolvable via NODE_PATH.
- **Parallel test runs**: The symlink removal was already safe because each test run uses a unique tmp directory. NODE_PATH is even safer — it's a per-spawn environment variable, not a filesystem mutation.
- **CI environment**: NODE_PATH must resolve in CI. If CI uses a different node_modules layout, adjust `NODE_PATH` to the actual resolution root.

---

## DEFER-APIGEN-PERF-001: worker_threads parallel extraction (STRETCH)

**Status:** Design-only until 10+ source files are processed in a single run. Premature parallelization adds overhead (~50ms worker startup, serialization costs) that outweighs benefits at small scale.

**Design:** An `ExtractionPool` class backed by [piscina](https://github.com/piscinajs/piscina) (gold-standard Node.js worker thread pool, maintained by Node.js core contributors). Workers are hosted via tsx's import loader so `.ts` worker files run without pre-compilation. The pool processes `{ filePath, tsconfig }` tasks in parallel, each worker running the existing `extract()` function on a single file.

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/apigen/apigen-core-client/src/lib/extraction-pool.ts` | create | 0 | 250 |
| `packages/apigen/apigen-core-client/src/lib/extraction-session.ts` | no change | 50 | 0 |
| `packages/apigen/apigen-core-client/src/index.ts` | modify | 30 | 20 |

### Interface changes (design)

#### New: `packages/apigen/apigen-core-client/src/lib/extraction-pool.ts`

```typescript
import Piscina from 'piscina';
import os from 'node:os';
import type { ExtractOptions, Operation } from './types';

export interface ExtractionPoolOptions {
  /** Max worker threads (default: os.availableParallelism()) */
  maxThreads?: number;
  /** Min idle threads kept warm (default: 1) */
  minThreads?: number;
  /** Idle timeout before worker is terminated (ms, default: 30_000) */
  idleTimeout?: number;
  /** Path to tsx loader for TypeScript worker hosting */
  tsxLoaderPath?: string;
}

export interface ExtractionTask {
  filePath: string;
  tsconfig?: string;
  options: Omit<ExtractOptions, 'file'>;
}

export class ExtractionPool {
  private pool: Piscina;
  private disposed = false;

  constructor(opts: ExtractionPoolOptions = {}) {
    this.pool = new Piscina({
      filename: new URL('./extraction-worker.ts', import.meta.url).href,
      minThreads: opts.minThreads ?? 1,
      maxThreads: opts.maxThreads ?? os.availableParallelism(),
      idleTimeout: opts.idleTimeout ?? 30_000,
      execArgv: ['--import', opts.tsxLoaderPath ?? 'tsx'],
    });
  }

  /** Submit a file for extraction. Returns Operation[] for that file. */
  async extract(task: ExtractionTask): Promise<Operation[]> {
    if (this.disposed) throw new Error('ExtractionPool used after dispose()');
    return this.pool.run(task) as Promise<Operation[]>;
  }

  /** Submit N files in parallel, collect results in order. */
  async extractAll(tasks: ExtractionTask[]): Promise<Operation[][]> {
    return Promise.all(tasks.map(t => this.extract(t)));
  }

  /** Graceful shutdown — waits for active tasks, terminates workers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pool.destroy();
  }

  /** Thread utilization (0–1). */
  get utilization(): number { return this.pool.utilization; }
  /** Queue depth. */
  get queueSize(): number { return this.pool.queueSize; }
}
```

#### New: `packages/apigen/apigen-core-client/src/lib/extraction-worker.ts`

```typescript
// Worker entry point — runs in a worker_thread, hosted by tsx.
// Import the real extract function (tsx resolves .ts at runtime).
import { extract } from './extract';
import type { ExtractionTask, Operation } from './types'; // Operation from descriptor.ts

export default async function (task: ExtractionTask): Promise<Operation[]> {
  return extract({
    file: task.filePath,
    tsconfig: task.tsconfig,
    ...task.options,
  });
}
```

### Behavioral changes

- **No change to existing `extract()` path:** The single-file `extract()` function is unchanged. `extraction-session.ts` is unchanged — persistent project tier is process-lifetime and NOT shared across workers (each worker gets its own process).
- **New parallel path:** Consumers with 10+ files call `ExtractionPool.extractAll(tasks)` instead of a sequential `for` loop. Results are collected in task order.
- **Worker lifecycle:** Pool is created once per run. `dispose()` called at end. Each worker loads ts-morph once (lib.d.ts parse) and reuses it across tasks in that worker.
- **Cost/benefit gate:** Pool creation adds ~50ms startup overhead per worker. Below ~50ms per file extraction, serial is faster. At 10+ files with ~200ms extraction each, parallel provides ~3-5x speedup.

### Independent segments

#### Segment A: extraction-pool.ts (NEW)

- **Files:** `packages/apigen/apigen-core-client/src/lib/extraction-pool.ts` (create)
- **Dependencies:** piscina (add to package.json), tsx (already in repo)
- **Read tokens:** 0 — new file
- **Output tokens:** ~250
- **Required context:** Read `src/lib/types.ts` for `ExtractOptions` and `Operation` types.

#### Segment B: extraction-worker.ts (NEW)

- **Files:** `packages/apigen/apigen-core-client/src/lib/extraction-worker.ts` (create)
- **Dependencies:** Segment A (pool references this file)
- **Read tokens:** 0 — new file
- **Output tokens:** ~60

#### Segment C: index.ts barrel export

- **Files:** `packages/apigen/apigen-core-client/src/index.ts` (add export)
- **Dependencies:** Segment A
- **Read tokens:** 30 — read existing exports
- **Output tokens:** 20 — add `export { ExtractionPool } from './lib/extraction-pool';`

#### Segment D: package.json dependency

- **Files:** `packages/apigen/apigen-core-client/package.json`
- **Dependencies:** none
- **Read tokens:** 20
- **Output tokens:** 10 — add `"piscina": "^5.0.0"` to dependencies

### Test cases

1. **Pool constructs and disposes** — `new ExtractionPool({ maxThreads: 2 })` then `await pool.dispose()` — no leaks
2. **Single-file extraction via pool** — `pool.extract({ filePath: 'fixtures/named.ts' })` returns same Operation[] as direct `extract()` call
3. **Multi-file parallel extraction** — `pool.extractAll([task1, task2, task3])` returns 3 arrays in correct order
4. **Disposed pool rejects** — calling `extract()` after `dispose()` throws
5. **Worker failure isolates to one task** — one bad file fails its promise, others succeed
6. **Utilization metric** — `pool.utilization` returns a number 0–1
7. **Negative control: pool dispose is idempotent** — calling `dispose()` twice does not throw

### Edge cases

- **Worker startup overhead:** First extraction may be slower (ts-morph cold start in worker). Warmup with a no-op task if latency-critical.
- **Memory per worker:** Each worker loads ts-morph's lib.d.ts (~100MB). With 8 workers, peak memory is ~800MB. Set `maxThreads` based on available RAM.
- **Production pre-compilation:** In production, pre-compile the worker to `.js` to eliminate the ~50ms tsx loader overhead per worker. The `execArgv` with `--import tsx` is a dev convenience.
- **Source file refresh:** Workers load files as snapshots. If a file changes mid-extraction, the worker sees the old version. This matches the current session-based design (one session = one snapshot).

---

## DEFER-PYENV-001: Windows Python interpreter discovery

**Root cause:** `BASE_CANDIDATES` in `python-env.ts` (line 88) is `['python3.13', 'python3.12', 'python3.11', 'python3']` — all Unix-only. On Windows, `python3` does not exist (python.org installs use `python.exe`), the Python launcher is `py.exe`, and the Windows Store stub exits with code 9009.

**Fix strategy:** Add Windows-specific candidates with platform-aware selection. Detect Windows Store stubs (exit code 9009 or 0-byte executable). Add CI coverage with a `windows-latest` job.

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/apigen/python-env/src/lib/python-env.ts` | modify | 150 | 120 |
| `packages/apigen/python-env/src/test/python-env.spec.ts` | modify | 80 | 80 |
| `.github/workflows/ci.yml` | create | 0 | 120 |

### Interface changes

#### `packages/apigen/python-env/src/lib/python-env.ts` — BASE_CANDIDATES + detection

```typescript
// BEFORE (line 88)
const BASE_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3']

// AFTER — platform-aware candidates
const UNIX_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3'];
const WINDOWS_CANDIDATES = ['py', '-3', 'python', 'python3'];
const BASE_CANDIDATES =
  process.platform === 'win32' ? WINDOWS_CANDIDATES : UNIX_CANDIDATES;
```

#### `packages/apigen/python-env/src/lib/python-env.ts` — interpreterVersion (enhanced)

```typescript
// BEFORE (lines 93-102) — accepts any non-zero exit as failure
function interpreterVersion(bin: string): [number, number] | undefined {
  const r = spawnSync(bin, ['-c', '...'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  // ... parse version
}

// AFTER — detect Windows Store stub (exit code 9009)
function interpreterVersion(bin: string): [number, number] | undefined {
  // On Windows, 'python' may be the Store stub which exits 9009 with no output.
  // Also check 'py' launcher which uses '-3' flag differently.
  const args = bin === '-3'
    ? ['-3', '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")']
    : ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'];

  const r = spawnSync(bin === '-3' ? 'py' : bin, args, {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });

  // Windows Store stub exits 9009 (file not found) or produces no output.
  if (r.status !== 0 || !r.stdout) return undefined;
  const trimmed = r.stdout.trim();
  if (trimmed.length === 0) return undefined; // Store stub: no version output

  const [maj, min] = trimmed.split('.').map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return undefined;
  return [maj, min];
}
```

#### `packages/apigen/python-env/src/lib/python-env.ts` — venvPython (already correct, no change)

```typescript
// Existing (line 118-122) — already handles Windows correctly
function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3')
}
```

#### `.github/workflows/ci.yml` (NEW)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: npx nx test python-env

  test-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v6
        with: { python-version: '3.12' }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: npx nx test python-env
```

### Behavioral changes

- **Unix: zero change.** `UNIX_CANDIDATES` is identical to the old `BASE_CANDIDATES`. Resolution order unchanged.
- **Windows: candidates become** `['py', '-3', 'python', 'python3']` — the Python launcher first, then the `-3` flag (launcher picks latest 3.x), then `python` (python.org install), then `python3` as fallback.
- **Windows Store stub detection:** The Store stub `python.exe` exits with code 9009 or produces empty stdout. `interpreterVersion` now returns `undefined` for empty stdout, preventing selection of a broken interpreter.
- **`shell: true` on Windows:** `spawnSync` needs `shell: true` on Windows to resolve `py` and `python` from PATH correctly (PATHEXT resolution).
- **`findBaseInterpreter` error message:** Enhanced to mention Windows-specific troubleshooting: "Run `python --version` in PowerShell. If it opens the Microsoft Store, install Python from python.org."

### Independent segments

#### Segment A: python-env.ts — BASE_CANDIDATES platform split

- **Files:** `packages/apigen/python-env/src/lib/python-env.ts` (line 88)
- **Dependencies:** none
- **Read tokens:** 30 — read line 88 and surrounding context
- **Output tokens:** 40 — replace one constant with platform-aware split

#### Segment B: python-env.ts — interpreterVersion enhancement

- **Files:** `packages/apigen/python-env/src/lib/python-env.ts` (lines 93-102)
- **Dependencies:** none
- **Read tokens:** 50
- **Output tokens:** 60 — add Store stub detection, `shell: true` on Windows, `py -3` arg handling

#### Segment C: python-env.ts — error message enhancement

- **Files:** `packages/apigen/python-env/src/lib/python-env.ts` (lines 111-116, `findBaseInterpreter`)
- **Dependencies:** none
- **Read tokens:** 30
- **Output tokens:** 30 — add Windows-specific troubleshooting to the error message

#### Segment D: python-env.spec.ts — Windows path tests

- **Files:** `packages/apigen/python-env/src/test/python-env.spec.ts`
- **Dependencies:** none (tests can run cross-platform — Windows-specific tests skip on non-Windows)
- **Read tokens:** 80 — read test structure
- **Output tokens:** 80 — add Windows candidate tests (skip if not win32)
- **Test additions:**
  - `it('BASE_CANDIDATES includes "python" on Windows')` — skip on !win32
  - `it('interpreterVersion rejects Windows Store stub')` — mock spawnSync to return 9009 exit
  - `it('findBaseInterpreter prefers "py" launcher on Windows')` — skip on !win32

#### Segment E: CI workflow (NEW)

- **Files:** `.github/workflows/ci.yml` (create)
- **Dependencies:** none
- **Read tokens:** 0 — new file
- **Output tokens:** 120

### Test cases

1. **Unix candidates unchanged:** On Linux/macOS, `BASE_CANDIDATES` = `['python3.13', 'python3.12', 'python3.11', 'python3']`
2. **Windows candidates include 'python':** On Windows, `BASE_CANDIDATES` = `['py', '-3', 'python', 'python3']`
3. **Windows Store stub rejected:** `interpreterVersion` returns `undefined` when spawn returns status 9009
4. **Empty stdout rejected:** `interpreterVersion` returns `undefined` when spawn produces zero-length stdout
5. **Version parse unchanged:** `interpreterVersion` on a valid Python returns correct `[major, minor]`
6. **`py -3` candidate works:** `-3` candidate delegates to `py` with `['-3', '-c', ...]` args
7. **CI windows-latest job passes:** `npx nx test python-env` on `windows-latest` → EXIT 0

### Edge cases

- **Windows without any Python:** `findBaseInterpreter` throws with a message mentioning both Unix candidates AND Windows troubleshooting.
- **Windows with only Store Python:** Store stub is detected and skipped. Error message says "If `python --version` opens the Microsoft Store, install Python from python.org."
- **`py` launcher not on PATH:** Falls through to `-3` (equivalent), then `python`, then `python3`.
- **`shell: true` overhead:** Only on Windows. On Unix, `shell` remains `false` (default). No performance regression.
- **CI linux job added:** Even though CI didn't exist before, adding a linux job ensures the existing Linux path is continuously verified.

---

## FEAT-001: Rate-limit tool calls with token bucket + SQLite persistence

**Root cause:** `BudgetPlugin` uses an in-memory `Map<string, BudgetAccumulator>` for all tracking. Tool call counts (`acc.toolCalls`) are lost on process restart. The `toolCalls` cap in `enforcePreTool` (line 749) increments a counter in the in-memory accumulator — surviving only as long as the process.

**Fix strategy:** Add SQLite-backed token bucket persistence for the `toolCalls` dimension. The token bucket algorithm provides burst tolerance (N calls allowed in a window) with continuous refill. Two new drizzle tables: `budget_token_buckets` (per-(scope, key, window) bucket state) and `budget_tool_calls` (per-call audit log). Rate limits survive process restart because state is in the shared SQLite database.

**Research backing:** `rate-limiter-flexible` with `better-sqlite3` is the recommended integration (2.6M weekly downloads, atomic UPSERT, ISC license). The token bucket follows the lazy refill pattern: tokens are computed on `enforcePreTool` as `min(capacity, tokens + (now - last_refill) * refill_rate)`, using `performance.now()` (monotonic) for refill timing. WAL mode + UPSERT eliminates race conditions.

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/agent/agent-plugin-budget/src/lib/token-bucket.ts` | create | 0 | 200 |
| `packages/agent/agent-plugin-budget/src/lib/schema.ts` | create | 0 | 120 |
| `packages/agent/agent-plugin-budget/src/index.ts` | modify | 200 | 250 |
| `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts` | modify | 200 | 250 |
| `packages/agent/agent-plugin-budget/package.json` | modify | 20 | 20 |

### Interface changes

#### New: `packages/agent/agent-plugin-budget/src/lib/token-bucket.ts`

```typescript
import Database from 'better-sqlite3';

export interface BucketKey {
  scope: 'task' | 'session' | 'agent' | 'global';
  scopeId: string;        // taskId, sessionId, agentName, or ''
  toolName: string;
  windowMs: number;       // refill window in milliseconds
}

export interface BucketState {
  tokens: number;
  lastRefill: number;     // performance.now() monotonic ms
  capacity: number;
  refillRate: number;     // tokens per millisecond
}

export class TokenBucketStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO budget_token_buckets
        (scope, scope_id, tool_name, window_ms, tokens, last_refill, capacity, refill_rate, expire_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id, tool_name, window_ms)
      DO UPDATE SET tokens = excluded.tokens, last_refill = excluded.last_refill
    `);
  }

  /**
   * Atomic consume: refill tokens lazily, then check if at least `cost` tokens
   * are available. If yes, deduct and return true. If no, return false.
   * Uses a single UPSERT — no SELECT-then-UPDATE race.
   */
  consume(key: BucketKey, cost: number): boolean {
    const now = performance.now();
    const state = this.getState(key);

    // Lazy refill
    const elapsed = now - state.lastRefill;
    const refilled = Math.min(state.capacity, state.tokens + elapsed * state.refillRate);
    const newTokens = refilled - cost;

    if (newTokens < 0) return false; // insufficient tokens

    this.insertStmt.run(
      key.scope,
      key.scopeId,
      key.toolName,
      key.windowMs,
      newTokens,
      now,
      state.capacity,
      state.refillRate,
      Date.now() + key.windowMs // expire after one full window of inactivity
    );
    return true;
  }

  /** Read current bucket state (creates default if not exists). */
  private getState(key: BucketKey): BucketState {
    const row = this.db.prepare(`
      SELECT tokens, last_refill, capacity, refill_rate
      FROM budget_token_buckets
      WHERE scope = ? AND scope_id = ? AND tool_name = ? AND window_ms = ?
    `).get(key.scope, key.scopeId, key.toolName, key.windowMs) as BucketState | undefined;

    if (row) return row;

    // Default: never initialized — return full bucket
    return {
      tokens: key.windowMs > 0 ? 1 : Infinity, // default 1 call allowed in window
      lastRefill: performance.now(),
      capacity: key.windowMs > 0 ? 1 : Infinity,
      refillRate: key.windowMs > 0 ? 1 / key.windowMs : 1,
    };
  }

  /** Initialize or reset a bucket with specific rate limits. */
  initBucket(key: BucketKey, capacity: number, windowMs: number): void {
    this.insertStmt.run(
      key.scope, key.scopeId, key.toolName, key.windowMs,
      capacity,           // tokens start at full capacity
      performance.now(),
      capacity,
      capacity / windowMs, // refill: capacity tokens per windowMs
      Date.now() + windowMs + 60_000
    );
  }
}
```

#### New: `packages/agent/agent-plugin-budget/src/lib/schema.ts`

```typescript
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Token bucket state — one row per (scope, scope_id, tool_name, window_ms). */
export const budgetTokenBuckets = sqliteTable('budget_token_buckets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull(),           // 'task' | 'session' | 'agent' | 'global'
  scopeId: text('scope_id').notNull(),       // taskId, sessionId, etc.
  toolName: text('tool_name').notNull(),
  windowMs: integer('window_ms').notNull(),  // refill window in ms
  tokens: real('tokens').notNull().default(0),
  lastRefill: integer('last_refill').notNull(), // monotonic ms
  capacity: real('capacity').notNull(),
  refillRate: real('refill_rate').notNull(),   // tokens per ms
  expireAt: integer('expire_at'),             // Unix ms — cleanup threshold
}, (table) => ({
  bucketKey: uniqueIndex('bucket_key').on(table.scope, table.scopeId, table.toolName, table.windowMs),
}));

/** Audit log of every tool call (for debugging + rate-limit forensics). */
export const budgetToolCalls = sqliteTable('budget_tool_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  sessionId: text('session_id'),
  agentName: text('agent_name').notNull(),
  toolName: text('tool_name').notNull(),
  callId: text('call_id').notNull(),
  allowed: integer('allowed', { mode: 'boolean' }).notNull(),
  tokensAtCall: real('tokens_at_call'),       // bucket token count at call time
  createdAt: integer('created_at').notNull(), // Unix ms
});
```

#### `packages/agent/agent-plugin-budget/src/index.ts` — BudgetPlugin constructor

```typescript
// BEFORE (line 230-234)
constructor(
  private readonly db: unknown,
  private readonly cfg: PluginConfig,
  private readonly costPerInput = 0,
  private readonly costPerOutput = 0
) {}

// AFTER — db is now typed, token bucket store is initialized
constructor(
  private readonly db: Database.Database | null, // null = no persistence
  private readonly cfg: PluginConfig,
  private readonly costPerInput = 0,
  private readonly costPerOutput = 0
) {
  if (db) {
    this.tokenBucket = new TokenBucketStore(db);
  }
}
private readonly tokenBucket?: TokenBucketStore;
```

#### `packages/agent/agent-plugin-budget/src/index.ts` — enforcePreTool (line 703-750)

**BEFORE** (line 749 — in-memory counter only):
```typescript
acc.toolCalls.set(toolName, currentToolCalls + 1);
```

**AFTER** — use token bucket when cap has a window, fall back to in-memory for window-less caps:
```typescript
// For caps WITH a window: use token bucket
for (const cap of caps) {
  if (cap.field === 'toolCalls' && cap.window && this.tokenBucket) {
    const windowMs = parseIsoDuration(cap.window);
    const bucketKey = {
      scope: (cap.scope ?? dimScope ?? 'task') as BucketKey['scope'],
      scopeId: this.scopeIdFor(bucketKeyScope, executionContext),
      toolName,
      windowMs,
    };
    this.tokenBucket.initBucket(bucketKey, cap.maximum, windowMs);
    const allowed = this.tokenBucket.consume(bucketKey, 1);
    // Log the call
    this.logToolCall(executionContext.taskId, toolName, callId, allowed);
    if (!allowed) {
      // ... throw enforcement error or tool warning (same as existing)
    }
  }
}
// For caps WITHOUT a window: use in-memory counter (existing behavior)
acc.toolCalls.set(toolName, currentToolCalls + 1);
```

### Behavioral changes

- **With DB (persistence):** Tool call rate limits survive process restarts. A task that exceeds its per-session tool call limit won't be able to restart and bypass the limit.
- **Without DB (backward compatible):** When `db` is `null` (existing callers), behavior is identical — in-memory counters only.
- **Token bucket laziness:** Token refill is computed on every `enforcePreTool` call, not on a timer. No background refill thread needed.
- **WAL mode:** The caller is responsible for enabling WAL mode on the SQLite connection (`PRAGMA journal_mode=WAL`). The token bucket store does NOT modify PRAGMAs — it uses the connection as-is.
- **Monotonic timing:** `performance.now()` prevents NTP/DST skew from affecting refill calculations.
- **Expire cleanup:** Buckets with `expireAt < Date.now()` can be cleaned up periodically. A cleanup query runs on `initBucket` calls (opportunistic, not a timer).

### Independent segments

#### Segment A: schema.ts (NEW)

- **Files:** `packages/agent/agent-plugin-budget/src/lib/schema.ts` (create)
- **Dependencies:** drizzle-orm (already a transitive dep via agent-engine-compiler)
- **Read tokens:** 0 — new file
- **Output tokens:** ~120

#### Segment B: token-bucket.ts (NEW)

- **Files:** `packages/agent/agent-plugin-budget/src/lib/token-bucket.ts` (create)
- **Dependencies:** Segment A (references table names), better-sqlite3 types
- **Read tokens:** 0 — new file
- **Output tokens:** ~200

#### Segment C: index.ts — constructor + enforcePreTool changes

- **Files:** `packages/agent/agent-plugin-budget/src/index.ts` (lines 230-234, 703-750, 838)
- **Dependencies:** Segments A+B
- **Read tokens:** 200 — re-read constructor, enforcePreTool, and factory function
- **Output tokens:** ~250 — modify constructor to accept typed db, integrate token bucket in enforcePreTool, add `scopeIdFor` helper

#### Segment D: package.json — dependency

- **Files:** `packages/agent/agent-plugin-budget/package.json`
- **Dependencies:** none
- **Read tokens:** 20
- **Output tokens:** 10 — add `"better-sqlite3": "*"` as peerDependency (the caller owns the connection)

#### Segment E: Tests

- **Files:** `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts`
- **Dependencies:** Segments A-D
- **Read tokens:** 200 — read existing test structure
- **Output tokens:** ~250 — add 5 new test cases (see below)

### Test cases

1. **Token bucket allows calls within limit:** Create bucket with capacity=5, window=60s. Consume 5 calls → allowed. 6th call → blocked.
2. **Token bucket refills over time:** Create bucket with capacity=3, window=1000ms. Consume 3 → exhausted. Advance clock 1000ms. Next consume → allowed (refilled to 3).
3. **Token bucket survives process restart:** Create bucket, consume 1, close DB, reopen, consume → tokens = capacity-2 (state persisted).
4. **Without DB — backward compatible:** `createPlugin({ db: null, config })` → tool calls tracked in-memory only (existing behavior).
5. **Tool call audit log:** Every call (allowed or blocked) logs to `budget_tool_calls` with `allowed` flag.
6. **Concurrent access safety:** Two rapid `consume` calls with WAL mode → no SQLITE_BUSY, correct token accounting.
7. **Negative control: bucket rejects over-capacity:** Capacity=1, try to consume 1 (allowed), then 1 more (blocked).

### Edge cases

- **Window boundary precision:** `performance.now()` is monotonic but wraps on some systems after ~285 years. Not a practical concern.
- **Zero window:** A cap with `window: 'PT0S'` means no refill — bucket is strictly limited to `capacity` total calls forever. Handled by `refillRate = 0`.
- **DB not available:** If `db` is null (existing callers), token bucket is skipped entirely. In-memory counters used. Zero behavior change.
- **Cleanup of expired buckets:** `expireAt` column enables periodic `DELETE WHERE expire_at < ?`. Not implemented in v1 — buckets are small (one row per unique scope+tool+window combo). Add cleanup in a follow-up if row count grows.
- **better-sqlite3 is synchronous:** The token bucket operations are synchronous — they block the event loop briefly. For the budget plugin (called on every tool call), this is acceptable because better-sqlite3 operations are ~0.1ms.

---

## DEFER-PYGRPC-001: gRPC-Web browser support

**Root cause:** The `pyGrpcPlugin` serves a Python gRPC server via raw HTTP/2 grpcio. Browsers cannot speak HTTP/2 gRPC (no TRAILERS support in the Fetch API). Two layers need changes: (1) Python side — add a gRPC-Web → gRPC translation layer, (2) TypeScript side — the `generate()` method currently returns `{ files: [] }` but should emit browser-compatible client stubs.

**Fix strategy:** **Envoy proxy approach** (zero Python server changes, production-grade). An Envoy sidecar with the `grpc_web` HTTP filter translates gRPC-Web (HTTP/1.1, `application/grpc-web-text`) to native gRPC (HTTP/2) transparently. The TypeScript plugin's `generate()` method produces `@connectrpc/connect` client stubs that call through Envoy. For greenfield projects, the alternative **connectrpc (Python)** approach eliminates the proxy entirely but requires migrating from grpcio.

**Research backing:** `@connectrpc/connect` (3.6M weekly, Buf-backed) is the recommended TypeScript client. `grpc-web` (official Google, 183k weekly) is the standard alternative. Envoy with `envoy.filters.http.grpc_web` is production standard. `grpcwebproxy` is blocked (unmaintained since 2021). `sonora` is blocked (GitHub-only, no PyPI). Critical antipattern: client/bidirectional streaming is NOT supported in gRPC-Web — only unary + server streaming (text mode only).

### Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/apigen/apigen-plugin-py-grpc/src/lib/generate-client.ts` | create | 0 | 200 |
| `packages/apigen/apigen-plugin-py-grpc/src/lib/envoy-template.ts` | create | 0 | 120 |
| `packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts` | modify | 100 | 80 |
| `packages/apigen/apigen-plugin-py-grpc/src/test/generate-client.spec.ts` | create | 0 | 200 |
| `packages/apigen/apigen-plugin-py-grpc/src/test/envoy-config.spec.ts` | create | 0 | 100 |

### Interface changes

#### New: `packages/apigen/apigen-plugin-py-grpc/src/lib/generate-client.ts`

```typescript
import type { PluginInput, File } from '@adhd/apigen-core-client';

export interface GrpcWebGenerateOptions {
  /** Protocol: 'grpc-web' (official Google) or 'connect' (Buf Connect-ES) */
  protocol?: 'grpc-web' | 'connect';
  /** gRPC-Web proxy URL (default: 'http://localhost:8080') */
  proxyUrl?: string;
  /** Package namespace (from RunInput.packages[0].id) */
  namespace: string;
  /** Service name: PascalCase(namespace) + 'Service' */
  serviceName: string;
  /** Method names and their input/output types */
  methods: Array<{
    name: string;
    inputType: string;
    outputType: string;
    streaming?: 'unary' | 'server_stream';
  }>;
}

/**
 * Generate a browser-compatible TypeScript client for a gRPC service.
 *
 * Produces two files:
 *   1. `<namespace>.client.ts` — typed client with one async method per RPC
 *   2. `envoy.yaml` — Envoy proxy config (if protocol='grpc-web')
 *
 * The client uses @connectrpc/connect for type-safe gRPC-Web calls through
 * the Envoy proxy. No .proto file needed — the client is generated from
 * apigen's descriptor (JSON-Schema types mapped to protobuf wire format).
 */
export function generateGrpcWebClient(opts: GrpcWebGenerateOptions): File[] {
  const files: File[] = [];

  if (opts.protocol === 'grpc-web' || !opts.protocol) {
    files.push(generateConnectClient(opts));
    files.push(generateEnvoyConfig(opts));
  } else {
    files.push(generateConnectClient(opts));
  }

  return files;
}

function generateConnectClient(opts: GrpcWebGenerateOptions): File {
  const methodDefs = opts.methods.map(m => {
    const streaming = m.streaming === 'server_stream' ? 'server_streaming' : 'unary';
    return `  ${m.name}: {
    name: '${m.name}',
    service: { typeName: '${opts.namespace}.${opts.serviceName}' },
    methodInfo: {
      localName: '${m.name}',
      name: '${m.name}',
      I: ${m.inputType},
      O: ${m.outputType},
      service: { typeName: '${opts.namespace}.${opts.serviceName}' },
      kind: MethodKind.${streaming === 'unary' ? 'Unary' : 'ServerStreaming'},
      idempotency: undefined,
    },
  }`;
  }).join(',\n');

  return {
    path: `${opts.namespace}.client.ts`,
    content: `// Generated by @adhd/apigen-plugin-py-grpc — gRPC-Web client
// Proxy: ${opts.proxyUrl ?? 'http://localhost:8080'}
// Service: ${opts.namespace}.${opts.serviceName}

import { createGrpcWebTransport, createClient, MethodKind } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';

// --- Import your generated types here ---
// (Generated separately by apigen's JSON-Schema → TypeScript codegen)
// import type { ${opts.methods.map(m => m.inputType).join(', ')} } from './types';

const transport: Transport = createGrpcWebTransport({
  baseUrl: '${opts.proxyUrl ?? 'http://localhost:8080'}',
});

export const ${opts.namespace}Client = {
${methodDefs}
};

// Usage:
//   import { ${opts.namespace}Client } from './${opts.namespace}.client';
//   const result = await ${opts.namespace}Client.${opts.methods[0]?.name ?? 'method'}({ ... });
`.trim(),
  };
}

function generateEnvoyConfig(opts: GrpcWebGenerateOptions): File {
  return {
    path: 'envoy.yaml',
    content: `# Envoy gRPC-Web proxy config — generated by @adhd/apigen-plugin-py-grpc
# Service: ${opts.namespace}.${opts.serviceName}
# Backend: localhost:50051 (Python grpcio server)

static_resources:
  listeners:
    - name: grpcweb_listener
      address:
        socket_address: { address: 0.0.0.0, port_value: 8080 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                codec_type: AUTO
                stat_prefix: ingress_http
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: grpc_service
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          route:
                            cluster: grpc_backend
                            timeout: 0s
                      cors:
                        allow_origin_string_match:
                          - prefix: "*"
                        allow_methods: "GET, PUT, DELETE, POST, OPTIONS"
                        allow_headers: "keep-alive,user-agent,cache-control,content-type,content-transfer-encoding,x-accept-content-transfer-encoding,x-accept-response-streaming,x-user-agent,x-grpc-web,grpc-timeout"
                        max_age: "1728000"
                        expose_headers: "grpc-status,grpc-message"
                http_filters:
                  - name: envoy.filters.http.grpc_web
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.Cors
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: grpc_backend
      type: STRICT_DNS
      connect_timeout: 5s
      http2_protocol_options: {}
      load_assignment:
        cluster_name: grpc_backend
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: 50051
`.trim(),
  };
}
```

#### `packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts` — generate() method

```typescript
// BEFORE (line 201-204)
generate(_input) {
  // py-grpc is a run-only plugin; no static codegen output.
  return { files: [] };
},

// AFTER
async generate(input) {
  const pkg = input.packages[0];
  if (!pkg) return { files: [] };

  const namespace = (input.options['namespace'] as string | undefined) ?? pkg.id;
  const serviceName = `${namespace.charAt(0).toUpperCase() + namespace.slice(1)}Service`;

  // Extract method info from the package's operations
  const methods = pkg.operations.map(op => ({
    name: op.name,
    inputType: `${namespace}.${op.name}Request`,
    outputType: `${namespace}.${op.name}Response`,
    streaming: (op.streaming ?? false) ? 'server_stream' as const : 'unary' as const,
  }));

  const protocol = (input.options['grpcWebProtocol'] as string | undefined) ?? 'grpc-web';
  const proxyUrl = input.options['proxyUrl'] as string | undefined;

  const files = generateGrpcWebClient({
    protocol: protocol as 'grpc-web' | 'connect',
    proxyUrl,
    namespace,
    serviceName,
    methods,
  });

  return { files };
},
```

#### `packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts` — optionsSchema

```typescript
// BEFORE (lines 193-199)
optionsSchema: {
  type: 'object',
  properties: {
    port: { type: 'number', default: 50051 },
    host: { type: 'string', default: '127.0.0.1' },
    namespace: { type: 'string' },
  },
},

// AFTER — add grpcWebProtocol + proxyUrl
optionsSchema: {
  type: 'object',
  properties: {
    port: { type: 'number', default: 50051 },
    host: { type: 'string', default: '127.0.0.1' },
    namespace: { type: 'string' },
    grpcWebProtocol: {
      type: 'string',
      enum: ['grpc-web', 'connect'],
      default: 'grpc-web',
      description: 'Client protocol: grpc-web (Envoy proxy) or connect (Buf Connect)',
    },
    proxyUrl: {
      type: 'string',
      description: 'gRPC-Web proxy URL (default: http://localhost:8080)',
    },
  },
},
```

### Behavioral changes

- **`generate()` now produces files:** Previously returned `{ files: [] }`. Now produces two files: a TypeScript client and an `envoy.yaml` proxy config.
- **Run path unchanged:** The `run()` method (spawns Python gRPC server) is not modified. gRPC-Web support is additive — the server still speaks native gRPC.
- **Envoy sidecar pattern:** Users run Envoy alongside the Python server. Envoy translates gRPC-Web (from browser) to gRPC (to Python). The generated `envoy.yaml` is a starting point.
- **Streaming constraints documented:** The generated client marks methods as `server_streaming` where applicable, but the client docs warn that browser client-streaming and bidirectional streaming are not supported by gRPC-Web.
- **Type imports are stubs:** The generated client imports types that must be generated separately (apigen's JSON-Schema → TypeScript codegen). The `generate()` method produces a working client skeleton; type generation is a separate concern.

### Independent segments

#### Segment A: generate-client.ts (NEW)

- **Files:** `packages/apigen/apigen-plugin-py-grpc/src/lib/generate-client.ts` (create)
- **Dependencies:** `@adhd/apigen-core-client` types (`PluginInput`, `File`)
- **Read tokens:** 0 — new file
- **Output tokens:** ~200

#### Segment B: plugin.ts — generate() replacement + optionsSchema

- **Files:** `packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts` (lines 193-206)
- **Dependencies:** Segment A
- **Read tokens:** 100 — re-read generate() and optionsSchema
- **Output tokens:** 80 — replace stub generate() with real implementation, add optionsSchema properties

#### Segment C: generate-client.spec.ts (NEW)

- **Files:** `packages/apigen/apigen-plugin-py-grpc/src/test/generate-client.spec.ts` (create)
- **Dependencies:** Segments A+B
- **Read tokens:** 0 — new file
- **Output tokens:** ~200

#### Segment D: envoy-config.spec.ts (NEW)

- **Files:** `packages/apigen/apigen-plugin-py-grpc/src/test/envoy-config.spec.ts` (create)
- **Dependencies:** Segment A
- **Read tokens:** 0 — new file
- **Output tokens:** ~100

#### Segment E: package.json — test dependency

- **Files:** `packages/apigen/apigen-plugin-py-grpc/package.json`
- **Dependencies:** none
- **Read tokens:** 20
- **Output tokens:** 10 — add `"@connectrpc/connect": "^2.0.0"` as optional dependency (for generated client consumers)

### Test cases

1. **generate() produces client file:** Call `generate()` with mock `PluginInput` → returns a `File[]` containing `<namespace>.client.ts`
2. **generate() produces envoy.yaml:** Call `generate()` with `protocol: 'grpc-web'` → returns envoy.yaml in files
3. **generate() does NOT produce envoy.yaml for connect protocol:** Call `generate()` with `protocol: 'connect'` → only client file, no envoy.yaml
4. **Client file is valid TypeScript:** Generated content parses as valid TypeScript (check syntax only — no runtime execution)
5. **Envoy config is valid YAML:** Generated envoy.yaml parses as valid YAML
6. **Methods are in correct order:** Generated client lists methods in the same order as package operations
7. **Server streaming methods use MethodKind.ServerStreaming:** Methods with `streaming: true` use ServerStreaming kind
8. **Empty packages produces empty files:** `generate()` with zero packages → `{ files: [] }`
9. **Custom proxyUrl appears in generated files:** `proxyUrl: 'https://api.example.com'` → appears in client baseUrl and envoy address
10. **Negative control: `generate()` without namespace falls back to package id**

### Edge cases

- **No browser client-side streaming:** gRPC-Web does not support client-streaming or bidirectional streaming. The generated client documents this limitation. Methods that need client streaming must use a different transport (WebSocket, Connect protocol with HTTP/2).
- **CORS misconfiguration:** If Envoy CORS is wrong, browser requests fail silently with opaque 0-status responses. The generated `envoy.yaml` includes correct CORS headers (`x-grpc-web`, `grpc-timeout`, `content-type` allowed; `grpc-status`, `grpc-message` exposed).
- **Envoy not running:** The generated client will fail at runtime if Envoy is not running. The docs include a startup command: `envoy -c envoy.yaml`.
- **Type generation gap:** The generated client imports types that must be generated separately. This is documented as a two-step process: (1) `apigen generate --type py-grpc` produces the client skeleton, (2) `apigen generate --type jsonschema` produces the TypeScript types.
- **Binary vs text mode:** The generated client defaults to `application/grpc-web-text` (base64-encoded, supports server streaming). Binary mode (`application/grpc-web+proto`) is faster for unary calls but breaks server streaming. The client uses text mode by default for compatibility.

---

## Execution order across items

Items are independent and can be implemented in parallel. Recommended order for a sequential executor:

1. **NB-1** (agent-store-prompts tsconfig) — trivial, one file, unblocks CI typecheck
2. **DEBT-CLI-001** (compiler test symlinks) — two files, moderate complexity
3. **DEFER-PYENV-001** (Windows Python) — three files, CI added
4. **FEAT-001** (token bucket tool rate limit) — four files, new abstractions
5. **DEFER-PYGRPC-001** (gRPC-Web) — four files, new client generation
6. **DEFER-APIGEN-PERF-001** (worker pool) — stretch goal, design-only

Items 1-3 have zero cross-item dependencies. Items 4 and 5 are independent. Item 6 is forward-looking design.

## Risk assessment

| Item | Risk | Rationale |
|------|------|-----------|
| NB-1 | **LOW** | Single-file config change, pattern already proven in sibling package |
| DEBT-CLI-001 | **LOW** | Build config + test refactor, nx cache makes build verification fast |
| DEFER-PYENV-001 | **MEDIUM** | Windows testing requires CI runner; fallback is manual verification |
| FEAT-001 | **MEDIUM** | New SQLite tables, token bucket algorithm; must not regress existing in-memory behavior |
| DEFER-PYGRPC-001 | **LOW** | Additive feature (generate() was stub), no change to running server |
| DEFER-APIGEN-PERF-001 | **LOW** | Design-only — no code changes until 10+ file threshold is reached |
