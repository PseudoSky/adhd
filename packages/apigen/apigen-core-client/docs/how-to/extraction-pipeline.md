# End-to-End Extraction Pipeline

How `extract`, `generateSchemas`, `composeSchemas`, and `ExtractionSession` fit together in a real workflow.

## The Pipeline

```
Source File (.ts)
       │
       ├── extract()           → Operation[]    (v2 descriptors)
       ├── generateSchemas()   → GeneratedSchemas (v1 JSON Schemas)
       ├── extractClasses()    → Operation[]    (class member descriptors)
       │
       ├── composeSchemas()    → ComposedSchemas (domain + middleware envelope)
       │
       └── Plugin.generate()   → File[]         (codegen)
```

## Step 1: Create a Session

All extraction calls in a logical run should share one `ExtractionSession` to avoid building redundant TypeScript programs:

```ts
import { createExtractionSession } from '@adhd/apigen-core-client';

const session = createExtractionSession();
```

## Step 2: Extract Operations (v2)

Use `extract()` for the full v2 descriptor pipeline:

```ts
import { extract } from '@adhd/apigen-core-client';

const ops = await extract({
  sourceFile: '/path/to/src/api.ts',
  namespace: 'myapp',
  tsconfig: '/path/to/tsconfig.json',
  session,
});

for (const op of ops) {
  console.log(`${op.id}  kind=${op.kind}  async=${op.async}`);
}
// myapp/api/getUser  kind=action  async=true
// myapp/api/getUsers kind=action  async=true
// myapp/api/CONFIG   kind=query   async=false
```

## Step 3: Generate Schemas (v1)

If you need the v1 `GeneratedSchemas` format (for `composeSchemas` or v1 plugins):

```ts
import { generateSchemas } from '@adhd/apigen-core-client';

const gen = await generateSchemas({
  sourceFile: '/path/to/src/api.ts',
  namespace: 'myapp',
  tsconfig: '/path/to/tsconfig.json',
  session,  // shares cache with extract() — zero redundant builds
});
```

`session.stats.schemaCacheHits` will be > 0 because `extract()` already computed the schemas.

## Step 4: Compose with Middleware

Fold middleware envelope fields into the composed input:

```ts
import { composeSchemas } from '@adhd/apigen-core-client';

const composed = composeSchemas(gen, [
  { id: 'auth', envelope: { session: { type: 'string' } } },
  { id: 'log',  envelope: { requestId: { type: 'string' } } },
], {
  // Suppress log middleware for the health check endpoint
  ping: { log: false },
});
```

## Step 5: Class Extraction (Optional)

If your source has exported classes, extract them separately:

```ts
import { extractClasses } from '@adhd/apigen-core-client';

const classOps = await extractClasses({
  sourceFile: '/path/to/src/Counter.ts',
  includeInstances: true,
  namespace: 'myapp',
  session,
});
```

## Step 6: Dispose

When the run's outputs have been consumed, dispose the session:

```ts
session.dispose();
```

## Session Lifetime Rule

- **One session per logical run** — file edits need a new session (invalidation = "new session").
- **Don't reuse across edits** — a session is a snapshot. The persistent tier handles process-lifetime reuse transparently.

## Performance Notes

- The first `extract()` or `generateSchemas()` call builds the ts-morph Project (~1–2s for lib.d.ts parsing). Subsequent calls in the same session are cache hits.
- The persistent tier survives `dispose()` — the next session reuses existing Projects (mtime+size version-checked).
- `APIGEN_PROGRAM_CACHE` (default 8) limits the built-generator cache. Set to `0` to disable persistence entirely.
- **Do not** `Promise.all` across `buildSchema` calls — the work is synchronous CPU and morph-walk mutates the shared SourceFile.

## See Also

- [`extract` reference](../reference/extract.md)
- [`generateSchemas` / `composeSchemas` reference](../reference/schemas.md)
- [`ExtractionSession` reference](../reference/session.md)
