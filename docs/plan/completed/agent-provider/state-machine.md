<!-- markdownlint-disable MD013 -->
# State machine — agent-provider (plan 3/7)

The structure lives in `dag.json` (nodes, deps, guards, artifacts); runtime
status lives in `state.json`. This file is the human-readable map.

## Phases

`foundation` → `schema` → `audit` (schema hold) → `adapter` → `runtime` →
`seed` → `audit` (final).

## Linear order

```text
scaffold-package            (foundation)  guard: nx build agent-provider
  → provider-and-model-schema (schema)    guard: nx test … model-store.test.ts
  → model-platform-bindings   (schema)    guard: nx test … binding-store.test.ts   [core value · dod.1]
  → provider-tool-formats     (schema)    guard: nx test … tool-format-store.test.ts
  → audit-schema              (audit)     guard: audit_provider.py --phase schema
  → provider-adapter-contract (adapter)   guard: nx test … adapter-resolve.test.ts  [dod.6]
  → runtime-tool-forwarding   (runtime)   guard: nx test … emit-tools.test.ts       [FEAT-007 · dod.2]
  → seed-and-roundtrip        (seed)      guard: nx test … roundtrip.test.ts        [dod.1 data · dod.3]
  → audit-final               (audit)     guard: audit_provider.py --phase final
  → done
```

Every guard is red→green and env-pinned (`npx --yes nx …` / `python3 …`).

## DoD → delivered-by map

| DoD | kind | delivered-by | proven by |
| --- | --- | --- | --- |
| dod.1 | behavioral | model-platform-bindings, seed-and-roundtrip | `binding-store.test.ts` (reopen) |
| dod.2 | behavioral | provider-tool-formats, runtime-tool-forwarding | `emit-tools.test.ts` (FEAT-007) |
| dod.3 | behavioral | seed-and-roundtrip | `roundtrip.test.ts` (idempotent + reopen) |
| dod.4 | structural | scaffold-package | grep `platform:node` |
| dod.5 | structural | provider-and-model-schema, model-platform-bindings, provider-tool-formats | grep `db/schema.ts` |
| dod.6 | structural | provider-adapter-contract | grep `ProviderAdapter` in agent-mcp-types |

Every work state appears in at least one `delivered-by`.

## Shared mutable files (append-only across states)

- `packages/ai/agent-provider/src/db/schema.ts` — each schema state adds tables.
- `packages/ai/agent-provider/src/index.ts` — each state extends the barrel.
- `packages/ai/agent-provider/drizzle` — each schema state adds a migration.
- `tsconfig.base.json` — scaffold-package adds the single path entry.
- `packages/ai/agent-mcp-types/src/{domain,index}.ts` — provider-adapter-contract
  additively declares `ProviderAdapter` + `StreamChunk`.

## Cross-plan edges

- **Upstream dep:** `agent-registry-schema` (DB topology: one shared SQLite file,
  `provider_*` prefix).
- **Shared interface home:** `@adhd/agent-mcp-types` (`ProviderAdapter`).
- **Downstream:** `agent-compiler` reads bindings + tool formats;
  `agent-mcp-refactor` wires the FEAT-007 emitter into live `anthropic.ts`.
