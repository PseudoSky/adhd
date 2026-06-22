# core-types — DEFINE SHARED TYPES IN @adhd/apigen-core

**Phase:** foundation · **Depends on:** scaffold-packages · **Guard:** `npx --yes nx build apigen-core`

---

## Goal

Populate `packages/apigen/core/src/lib/types.ts` with all the shared TypeScript types and the `OutputPlugin` interface that every other package imports. After this state, `@adhd/apigen-core` builds cleanly with the complete public type surface. No runtime logic yet — `generateSchemas` and `composeSchemas` may be stubs that throw `Error('not implemented')`.

This state exists first because: `@adhd/apigen-runtime` imports `GeneratedSchemas` and `ComposedSchemas` from core; plugins import `ComposedSchemas` and `OutputPlugin`; the CLI imports everything. Getting the type contracts right before writing logic prevents cascading refactors.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/core/src/lib/types.ts` — the contract file all packages depend on.
- **Reference Pattern:** No existing apigen packages. Look at `packages/ai/agent-mcp-types/src/index.ts` for the established pattern of types-only packages in this workspace.
- **Delta Spec:**

**`packages/apigen/core/src/lib/types.ts`** — full content:

```typescript
// Output of generateSchemas() — domain schemas only, no middleware envelope
export interface GeneratedSchemas {
  metadata: { namespace: string; phase: string }
  schemas: Record<string, {
    input:  Record<string, unknown>
    output: Record<string, unknown>
  }>
}

// Output of composeSchemas() — domain + middleware envelope merged
// data: {} wrapper is ALWAYS present, even for zero-param functions
export type ComposedSchemas = Record<string, {
  input:  Record<string, unknown>
  output: Record<string, unknown>
}>

// Three mutually exclusive extraction modes
export type ExportMode =
  | { type: 'named' }
  | { type: 'default' }
  | { type: 'named-object'; name: string }

// Options for generateSchemas()
export interface GenerateSchemasOptions {
  sourceFile: string       // absolute path to .ts source file
  exportMode?: ExportMode  // default: { type: 'named' }
  namespace?: string       // written to metadata (informational)
  phase?: string           // written to metadata (informational)
}

// Plugin system — language-agnostic: files[] can contain any language
export interface PluginInput {
  packages: Array<{
    id: string
    schemas: ComposedSchemas
    importPath: string
    fns?: Record<string, (...args: unknown[]) => unknown>
    createClient?: (envelope: Record<string, unknown>) => Promise<unknown>
  }>
  outputDir: string
  options: Record<string, unknown>
}

export interface PluginOutput {
  files: Array<{ path: string; content: string }>
  postCommands?: string[]
}

export interface RunInput extends PluginInput {
  signal?: AbortSignal
}

export interface OutputPlugin {
  id: string
  description: string
  optionsSchema?: Record<string, unknown>
  generate(input: PluginInput): PluginOutput | Promise<PluginOutput>
  run?(input: RunInput): Promise<void>
}
```

**`packages/apigen/core/src/index.ts`** — stub exports:

```typescript
export type {
  GeneratedSchemas,
  ComposedSchemas,
  ExportMode,
  GenerateSchemasOptions,
  PluginInput,
  PluginOutput,
  RunInput,
  OutputPlugin,
} from './lib/types'

// Stubs — implemented in subsequent states
export async function generateSchemas(
  _opts: import('./lib/types').GenerateSchemasOptions
): Promise<import('./lib/types').GeneratedSchemas> {
  throw new Error('not implemented — see schema-extraction state')
}

export function composeSchemas(
  _domainSchemas: import('./lib/types').GeneratedSchemas,
  _middlewares: ReadonlyArray<{ id: string; envelope?: Record<string, unknown> }>,
  _overrides?: Record<string, Record<string, boolean>>,
): import('./lib/types').ComposedSchemas {
  throw new Error('not implemented — see schema-composition state')
}
```

- **Invariants:** `[inv:ctx-name-only]`, `[inv:data-wrapper-always-present]`, `[inv:false-suppresses-middleware]`, `[inv:language-agnostic-output]`

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/core/src/lib/types.ts",
            "packages/apigen/core/src/index.ts"]
read_only:  ["packages/apigen/"]
```

---

## Acceptance criteria

- `[core-types.1]` `npx --yes nx build apigen-core` exits 0.
- `[core-types.2]` `@adhd/apigen-core` exports `GeneratedSchemas`, `ComposedSchemas`, `ExportMode`, `OutputPlugin`:
  ```bash
  node -e "const t=require('./packages/apigen/core/src/index.ts'); console.log(typeof t.generateSchemas)"
  # or after build: node -e "const t=require('./dist/packages/apigen/core/index.cjs'); ..."
  ```
  (Use tsc path — check build output actually exports the types.)
- `[core-types.3]` `generateSchemas` stub throws `Error('not implemented …')` when called — not silently returns undefined:
  ```bash
  node -e "require('./dist/packages/apigen/core/index.cjs').generateSchemas({sourceFile:'x'}).catch(e=>{ if(!e.message.includes('not implemented')) throw new Error('wrong error'); process.exit(0) })"
  ```
- `[core-types.4]` No `import` from `@adhd/apigen-runtime` or any plugin in `packages/apigen/core/`:
  ```bash
  grep -rn "@adhd/apigen-runtime\|@adhd/apigen-plugin" packages/apigen/core/src/
  # must produce no output
  ```

---

## Commit points

1. After `types.ts` and `index.ts` are written and build passes: `feat(apigen-core): add shared type contracts — GeneratedSchemas, ComposedSchemas, OutputPlugin`
