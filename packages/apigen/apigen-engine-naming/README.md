# @adhd/apigen-engine-naming

Naming and identifier helpers for apigen — case conversion, file-name normalization,
namespace/project id derivation, export collision detection, and the §9.1 envelope-key
conventions. Pure TypeScript (**platform: shared**).

Part of [apigen](../README.md).

## Public API

```ts
import {
  toKebab, toCamel, toPascal, toSnake, normalizeFileName,
  project, httpVerb, checkCollisions, CollisionDetectedError,
  envelopeKey, envelopeCliFlag, envelopeEnvVar, envelopeMetaKey,
  sanitizeIdentifier, uniqueSanitizedIdentifiers,
  escapeStringLiteral, escapeLineTerminators, toPosixPath, coercePort,
} from '@adhd/apigen-engine-naming';
```

- **case helpers** — `toKebab` / `toCamel` / `toPascal` / `toSnake`, `normalizeFileName`.
- **`project(...)`** — derive the namespace/id for a source.
- **`httpVerb(...)`** — resolve the effective HTTP verb for a composed schema.
- **`checkCollisions(...)`** — detect duplicate export ids (throws `CollisionDetectedError`).
- **envelope keys** — map an envelope field to its CLI flag / env var / MCP `_meta` key.
- **codegen emit primitives** (the single, context-correct surface every generator splices a
  dynamic value through — see `src/lib/emit.ts`):
  - `sanitizeIdentifier(id)` — a discovered id → a valid identifier.
  - `uniqueSanitizedIdentifiers(ids)` — a collision-free **set** of identifiers (a lossy
    sanitisation can map distinct ids to the same name; this disambiguates with a stable
    `_2`, `_3`, … suffix so generated `import * as …_ns` declarations never collide).
  - `escapeStringLiteral(value)` — a complete, quoted JS/TS string literal (escapes quotes,
    backslashes, control chars, and `U+2028`/`U+2029`).
  - `escapeLineTerminators(text)` — the `U+2028`/`U+2029` escape applied to an already-
    serialized blob (e.g. a `JSON.stringify`'d schema map) before it is spliced.
  - `toPosixPath(p)` — normalise a path to `/` separators.
  - `coercePort(value)` — a caller-supplied `port` option → a validated integer literal
    (rejects blank/non-numeric/out-of-range values instead of splicing them).
