# @adhd/apigen-core

Schema **extraction** and **composition** for apigen, plus the shared types and the
`OutputPlugin` contract every target plugin implements. Pure TypeScript — safe in Node and
the browser (**platform: shared**).

Part of [apigen](../README.md). For end-to-end usage see [`../cli`](../cli).

## What it does

Reads a TypeScript source with [ts-morph](https://ts-morph.com/), derives JSON Schemas for
each exported function's parameters and return type (via `ts-json-schema-generator`), and
composes them with any middleware-contributed envelope fields. The first parameter named
`ctx` is excluded from the schema by convention (name-only).

## Public API

```ts
import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import type {
  GeneratedSchemas, ComposedSchemas, ExportMode, GenerateSchemasOptions,
  PluginInput, PluginOutput, RunInput, OutputPlugin, Logger,
} from '@adhd/apigen-core'
```

- **`generateSchemas(opts)`** — source file → per-export input/output JSON Schemas.
- **`composeSchemas(...)`** — fold middleware envelope fields into the composed `input`
  (always with a `data: {}` wrapper, even for zero-param functions).
- **`OutputPlugin`** — `{ id, generate(input): PluginOutput, run?(input): Promise<void> }`.
  `PluginOutput.files` is language-agnostic (`{ path, content }[]`), so plugins may emit any
  file type.

## Extraction sessions & caching

Building a TypeScript program (parse lib.d.ts + type-check) is the dominant cost of
extraction. Two cache layers keep it O(1):

- **Per-run `ExtractionSession`** — pass one `session` to every `extract` /
  `generateSchemas` / `extractClasses` call in a logical run and they share one ts-morph
  Project per tsconfig, one schema generator per file, and memoized `(file, typeText)`
  schemas. `dispose()` releases the run. Calls without a session create and dispose a
  private one, so it's always optional.

  ```ts
  import { createExtractionSession, extract, generateSchemas } from '@adhd/apigen-core'

  const session = createExtractionSession()
  try {
    const ops = await extract({ sourceFile, tsconfig, session })
    const gen = await generateSchemas({ sourceFile, tsconfig, session }) // pure cache hits
  } finally {
    session.dispose()
  }
  ```

- **Persistent tier (process lifetime)** — Projects, generators, and schema fragments are
  reused across sessions in the same process (watch/serve rebuilds, test loops), version-
  checked by mtime+size and refreshed in place on edit. Warm runs cost milliseconds. The
  generator cache is LRU-capped (`APIGEN_PROGRAM_CACHE`, default 8; each entry is a full
  TS program, ~100–200MB — `0` disables persistence). `clearPersistentProjectCache()`
  reclaims everything explicitly.

  Invalidation caveat: versions track the *entry* file; an edit to a file it merely
  imports is not detected until the entry file changes (root BACKLOG
  DEBT-APIGEN-CACHE-001).

Do **not** parallelize the per-parameter `buildSchema` loops: the work is synchronous CPU
under an async signature, and morph-walk mutates the shared SourceFile (probe aliases), so
`Promise.all` gains nothing and can race.

## Develop

```bash
npx nx build apigen-core
npx nx test  apigen-core
```
