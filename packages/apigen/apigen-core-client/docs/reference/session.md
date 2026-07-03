# extraction session

Per-run shared cache for the extraction pipeline — eliminates redundant TypeScript program builds across `extract`, `generateSchemas`, and `extractClasses` calls.

## Exports

### `createExtractionSession(): ExtractionSession`

Creates a fresh `ExtractionSession` — one session = one run = one snapshot of the source tree.

A session scopes all of the extraction pipeline's heavy resources to a single run:
- One ts-morph `Project` per distinct tsconfig (lib.d.ts parses once per run)
- One `ts-json-schema-generator` per `(file, tsconfig)`
- Each `(file, typeText)` schema computed once (the orchestrator's extract + generateSchemas double pass becomes cache hits)
- `fs.stat` and import-alias scans memoized per file

Reusing a session across file edits is unsupported — invalidation is "new session."

```ts
import { createExtractionSession, extract, generateSchemas } from '@adhd/apigen-core-client';

const session = createExtractionSession();
// session.stats → { projectsBuilt: 0, generatorsBuilt: 0, schemaCacheHits: 0, schemaCacheMisses: 0 }

const ops = await extract({ sourceFile: './api.ts', session });
// session.stats.projectsBuilt → 1

const gen = await generateSchemas({ sourceFile: './api.ts', session });
// session.stats.generatorsBuilt → 1, schemaCacheHits > 0 — pure cache hits

session.dispose();
```

### `ExtractionSession`

```ts
interface ExtractionSession {
  dispose(): void;          // drop per-run caches, release memory
  readonly stats: ISessionStats;  // live work counters
}
```

Passing a session is optional everywhere — calls without one create a private session internally and dispose it before returning.

### `ISessionStats`

Live counters proving how much work a session actually did:

```ts
interface ISessionStats {
  projectsBuilt: number;     // ts-morph Projects constructed (one per distinct tsconfig per session)
  generatorsBuilt: number;   // ts-json-schema-generator generators (full TS programs) constructed
  schemaCacheHits: number;   // buildSchema calls answered from session schema cache
  schemaCacheMisses: number; // buildSchema calls that had to compute
}
```

### `clearPersistentProjectCache(): void`

Drops the process-lifetime Project and schema caches. Used in tests (beforeEach) and for explicit memory reclaim.

```ts
import { clearPersistentProjectCache } from '@adhd/apigen-core-client';

// Start a fresh cold run — next session builds everything from scratch.
clearPersistentProjectCache();
const session = createExtractionSession();
// session.stats.projectsBuilt → 1 (fresh construction, not reused)
```

## Architecture

### Two-Tier Cache

1. **Per-session tier** — `dispose()` releases it. Created fresh per run.
2. **Persistent process-lifetime tier** — reused across sessions in the same process (watch mode, serve rebuilds, test loops).

The persistent tier is:
- **Version-checked** by mtime+size — edited files refresh in place, never duplicated.
- **Bounded** — one Project per distinct tsconfig, one SourceFile per distinct file, one schema map per `(file, tsconfig)`. A working set, not a leak.
- **LRU-capped** — `APIGEN_PROGRAM_CACHE` env var controls the built-generator cap (default 8). Each entry is a full TS program (~100–200 MB). Set to `0` to disable persistence entirely.

### Invalidation Caveat

Versions track the *entry* file only. An edit to a file it merely imports is not detected until the entry file changes (tracked in root BACKLOG: DEBT-APIGEN-CACHE-001).

### Do Not Parallelize `buildSchema`

The per-parameter `buildSchema` loops are synchronous CPU under an async signature. morph-walk mutates the shared SourceFile (probe aliases), so `Promise.all` gains nothing and can race.

## See Also

- [How-To: Extraction Pipeline](../how-to/extraction-pipeline.md)
