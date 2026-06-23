# @adhd/apigen-naming

Naming and identifier helpers for apigen — case conversion, file-name normalization,
namespace/project id derivation, export collision detection, and the §9.1 envelope-key
conventions. Pure TypeScript (**platform: shared**).

Part of [apigen](../README.md).

## Public API

```ts
import {
  toKebab, toCamel, toPascal, toSnake, normalizeFileName, project,
  checkCollisions, CollisionDetectedError,
  envelopeKey, envelopeCliFlag, envelopeEnvVar, envelopeMetaKey,
} from '@adhd/apigen-naming'
```

- **case helpers** — `toKebab` / `toCamel` / `toPascal` / `toSnake`, `normalizeFileName`.
- **`project(...)`** — derive the namespace/id for a source.
- **`checkCollisions(...)`** — detect duplicate export ids (throws `CollisionDetectedError`).
- **envelope keys** — map an envelope field to its CLI flag / env var / MCP `_meta` key.
