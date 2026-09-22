# SHIM-REMOVAL — measured blast radius

State `tsconfig-shim-removal` removed five migration-only relaxations from the
shared compiler config `tsconfig.base.json`. This file records the **measured**
blast radius (real commands, real output) and the negative-control proof that the
build gate has teeth.

## What was removed

| Key | Where it lived | Value removed |
|---|---|---|
| `strict` | `compilerOptions` | `false` |
| `noUncheckedSideEffectImports` | `compilerOptions` | `false` |
| `types` | `compilerOptions` | `["*"]` |
| `esModuleInterop` | `compilerOptions` | `false` |
| `ignoreDeprecations` | `compilerOptions` **and** `ts-node.compilerOptions` | `"6.0"` |

All six occurrences (the fifth key appeared twice) were deleted. No key remains in
`compilerOptions`; the guard's `node -e` key check exits 0.

## Measured blast radius

Measured with a walk of every `tsconfig*.json` under the worktree (excluding
`node_modules`, `.git`, `dist`, `.nx`), resolving each file's `extends` chain to
determine whether it reaches `tsconfig.base.json`, and checking each reaching
config for a local override of each removed key.

```
total tsconfig*.json files (excl. node_modules/.git/dist/.nx): 195
configs that reach tsconfig.base.json via extends chain:        193
```

| Removed key | Configs that INHERIT it | Configs that OVERRIDE it |
|---|---:|---:|
| `strict` | 137 | 56 |
| `types` | 69 | 124 |
| `esModuleInterop` | 175 | 18 |
| `ignoreDeprecations` | 123 | 70 |
| `noUncheckedSideEffectImports` | 193 | 0 |

(Note: the plan context estimated "~62 configs reaching the shared config"; the
measured figure is **193**. The stated number was not used.)

## Which removal changed a build outcome

**None.** Every removed value is either a TypeScript default or had nothing to act on:

- `strict: false` — TS default is `false`; removal is a no-op.
- `esModuleInterop: false` — TS default is `false`; removal is a no-op.
- `noUncheckedSideEffectImports: false` — TS default is `false`; removal is a no-op.
- `types: ["*"]` — equivalent to leaving `types` unspecified (all `@types` packages);
  removal is a near-no-op.
- `ignoreDeprecations: "6.0"` — the one key that could suppress *real* diagnostics.
  A scan of every `tsconfig*.json` for TS-6.0-deprecated options
  (`charset`, `importsNotUsedAsValues`, `keyofStringsOnly`, `noImplicitUseStrict`,
  `noStrictGenericChecks`, `out`, `preserveValueImports`, `suppressExcessPropertyErrors`,
  `suppressImplicitAnyIndexErrors`) returned **zero matches** — there was nothing to
  suppress. `ignoreDeprecations` proved **NOT load-bearing**.

Guard build after removal: cache **0/5 → rebuilt from scratch → 5/5 success** (the
nx cache genuinely invalidated, because `tsconfig.base.json` is a `sharedGlobals`
input — `nx.json:34` — so the green result is a real type-check, not a cache hit).

## Negative control — the gate has teeth

The green build above is only meaningful if the build actually type-checks. Proven
by injecting a deliberate type error and confirming the gate goes red:

1. Injected into `packages/agent/agent-base-types/src/index.ts`:
   ```ts
   export const __negativeControl: number = 'not a number';
   ```
2. Ran the guard's build:
   ```
   ./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy
   ```
   Result: **exit 130**, `Found type errors.`, `agent-base-types:build` failed.
   (The `@nx/vite:build` path type-checks via `vite-plugin-dts`.)
3. Reverted the injection (`git restore packages/agent/agent-base-types/src/index.ts`).
4. Re-ran the guard: **exit 0**, 5/5 success.

The working tree was left exactly as found apart from `tsconfig.base.json` and this
file.

## Guard

```
node -e "const c=require('./tsconfig.base.json').compilerOptions;for(const k of ['strict','types','esModuleInterop','ignoreDeprecations','noUncheckedSideEffectImports'])if(k in c)process.exit(1)" \
&& ./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy
```

- **Red before:** key check exited 1 (all five keys present).
- **Green after:** key check exits 0; build succeeds (real rebuild, 5/5).
