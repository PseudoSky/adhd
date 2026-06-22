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

## Develop

```bash
npx nx build apigen-core
npx nx test  apigen-core
```
