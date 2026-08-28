# Implementation Spec — FEAT-APIGEN-TS-TYPE-CODEGEN-001

**Chain:** product → **architect** → typescript → review
**Worktree:** `.worktrees/chain-20260802-183630-6422a0`
**Feature:** apigen JSON-Schema→TS-type-declaration codegen path (`--type ts-types`)
**Implementer:** flash-tier agent (deepseek-v4-flash). **Reviewer:** flash-tier reviewer.
**Date:** 2026-08-02

---

## Summary

Add a generate-only apigen output target `ts-types` that emits one TypeScript type-declaration
file per exported function (named interfaces/types — never inline `object`, never degraded
`any`/`unknown` for the discriminated-union case). A new dependency-free plugin package
`@adhd/apigen-plugin-ts-types` hand-rolls a bounded JSON-Schema→TS emitter; one registration
line in the apigen-cli plugin map exposes it; a default-running consumer test spawns the built
CLI against a fixture and esbuild-compiles the emitted output (explicitly not `node --check`,
not hand-run `tsc`). The `oneOf`+`discriminator` (`_batch` shape) case emits a named
discriminated union with each branch as a named interface and the discriminant property retained.

---

## Design decisions (locked — reviewer must verify against these)

1. **Target id: `ts-types`.** Matches the package-name→id convention of every sibling
   (`apigen-plugin-jsonschema` → `jsonschema`; drop the `apigen-plugin-` prefix). Not `ts-client`.
2. **Dependency: HAND-ROLLED emitter — dependency-free at runtime.** Trade-off stated in
   §Emitter. The plugin's only runtime deps are the two already-used workspace packages
   (`@adhd/apigen-core-client`, `@adhd/apigen-engine-naming`) plus `node:path`.
   **No `json-schema-to-typescript`, no new runtime 3rd-party dep — therefore no human
   external-dep approval is required for the feature.** `esbuild` is added as a **devDependency**
   to two packages only so the compile-check test can import it; esbuild is already in the repo's
   pnpm lockfile transitively (vite/vitest depend on it) — this is a lockfile *promotion* of an
   already-present tool, not the installation of a new external tool. Reviewer watch-item: if you
   read AGENTS.md "approval before installing external tools" strictly, the *feature* dep decision
   needs no approval (zero new runtime deps); the esbuild devDep is tooling already in the tree.
3. **Schema source: `PluginInput.operations` (SPEC §4 data-wrapper-dissolved) is the PRIMARY
   path** — `orchestrateGenerate` populates it (orchestrator.ts:594). Fallback to
   `pkg.schemas[fnName]` with a data-wrapper unwrap when `operations` is absent (hand-built
   `PluginInput` in unit tests / non-TS paths). This keeps emitted `Input` types as the true
   params object, never `{ data: {...} }`.
4. **Per-fn files `<pkgId>/<fnName>.ts`; PACKAGE-QUALIFIED type names** —
   `sanitizeIdentifier(toPascal(tokenize(pkgId))) + Pascal(fnName) + Input|Output`
   (e.g. pkg `dispatch-cli`, fn `validate` → `DispatchCliValidateInput`). This makes
   `sanitizeIdentifier` genuinely load-bearing (a hyphenated pkg id enters identifier positions),
   satisfies acceptance bar 5, and gives collision-free names if a consumer imports several
   packages' output. No barrel/index file in round 1 (scope control).
5. **Discriminated union:** `oneOf` + `discriminator` (+ `mapping`) → a named union type
   (`export type X = BranchA | BranchB`) plus one named interface per branch; each branch
   interface **retains** the discriminant property as a literal (`kind: 'cat'`). `oneOf` without
   a `discriminator`, `anyOf`, `allOf` → REJECT with a clear error (round-1 contract). No
   `any`/`unknown`/`object` fallback in the union path.
6. **Compile check = esbuild `transform(content, { loader: 'ts' })`** in tests, with a negative
   control (mutated output with a bare `-` splice must reject). This is the mechanism the
   acceptance bar requires (BUG-APIGEN-032 proved `node --check` permissive; AGENTS.md forbids
   hand-run `tsc`).

---

## Files

| Path (worktree-relative) | Change | Purpose |
|---|---|---|
| `packages/apigen/apigen-plugin-ts-types/` | **create (scaffold)** | New plugin package via generator (never hand-created) |
| `packages/apigen/apigen-plugin-ts-types/src/lib/emit-types.ts` | create | The emitter: JSON-Schema→TS string logic (pure functions, exported for tests) |
| `packages/apigen/apigen-plugin-ts-types/src/lib/plugin.ts` | create | `OutputPlugin` object (id/description/language/optionsSchema/generate) |
| `packages/apigen/apigen-plugin-ts-types/src/index.ts` | create (generator emits stub; overwrite) | Re-export `{ tsTypesPlugin }` + default |
| `packages/apigen/apigen-plugin-ts-types/src/test/emit-types.spec.ts` | create | Emitter unit tests incl. discriminated union, sanitizeIdentifier, rejections, esbuild compile check + negative control |
| `packages/apigen/apigen-plugin-ts-types/package.json` | modify (generated) | Add `@adhd/apigen-engine-naming` dep; add `esbuild` devDep; keep generated name/version |
| `packages/apigen/apigen-plugin-ts-types/README.md` | modify (generated stub) | Real one-paragraph README |
| `packages/apigen/apigen-plugin-ts-types/CHANGELOG.md` | create | Minimal 0.0.1 entry (in `files` list) |
| `entrypoint/apigen-cli/src/index.ts` | modify | Import + one map line `'ts-types': tsTypesPlugin` |
| `entrypoint/apigen-cli/package.json` | modify | Add `@adhd/apigen-plugin-ts-types` dep + `esbuild` devDep |
| `entrypoint/apigen-cli/src/test/fixtures/ts-types-source.ts` | create | CLI fixture (primitives/object/array/enum + discriminated union fn) |
| `entrypoint/apigen-cli/src/test/e2e/ts-types.spec.ts` | create | Default-running consumer test: spawn built CLI `generate` + `list-types`, assert exit code/content, esbuild-compile emitted files |
| `docs/apigen/SPEC.md` | modify | New §6.1 `ts-types` output target with example invocation |
| `entrypoint/apigen-cli/AGENTS.md` | modify | Plugin reference table row `ts-types` |
| `tsconfig.base.json` | modify (BY GENERATOR ONLY) | Generator adds `@adhd/apigen-plugin-ts-types` path |

**Do NOT touch:** any other plugin, `plugin-registry.ts` (no change needed — `list-types`/help
derive from the map), the orchestrator, `compose-schemas`, any host `run.ts`, `nx.json`.

---

## Interface changes

### New: `packages/apigen/apigen-plugin-ts-types/src/lib/plugin.ts`

```ts
import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core-client';
import * as path from 'node:path';
import { emitFnTypes } from './emit-types';

export const tsTypesPlugin: OutputPlugin = {
  id: 'ts-types',
  description: 'Emit one TypeScript type-declaration file per function per package',
  language: 'ts',
  optionsSchema: { type: 'object', properties: {} },
  generate(input: PluginInput): PluginOutput {
    const files: PluginOutput['files'] = [];
    for (const pkg of input.packages) {
      // pkgPrefix = sanitizeIdentifier(toPascal({raw: pkg.id, words: tokenize(pkg.id)}))
      for (const [fnName, schema] of fnSchemasFor(pkg, input)) {
        files.push({
          path: path.join(pkg.id, `${fnName}.ts`),
          content: emitFnTypes(pkgPrefixFor(pkg.id), fnName, schema),
        });
      }
    }
    return { files };
  },
};
export default tsTypesPlugin;
```

`fnSchemasFor(pkg, input)` — merge `input.operations` (primary; `fnName = op.path.at(-1)?.raw
?? op.id.split('/').pop()`, schema `{ input: op.input, output: op.output }`) with
`pkg.schemas[fnName]` fallback (unwrap the `data` wrapper — see below) for fn names not already
present. Operations win on name collision.

### New: `packages/apigen/apigen-plugin-ts-types/src/lib/emit-types.ts` (exports)

```ts
export function emitFnTypes(pkgPrefix: string, fnName: string,
  schema: { input: unknown; output: unknown }): string;
export function unwrapDataWrapper(input: unknown): unknown;
export function typeName(pkgPrefix: string, raw: string, suffix: 'Input' | 'Output'): string;
```

`emitFnTypes` returns the full file content string. `typeName` =
`sanitizeIdentifier(toPascal({ raw, words: tokenize(raw) }))` with `pkgPrefix` already sanitized,
e.g. `typeName('DispatchCli', 'validate', 'Output')` → `DispatchCliValidateOutput`.

### Modified: `entrypoint/apigen-cli/src/index.ts`

```ts
// BEFORE (line 9 region)
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema';
// AFTER — add immediately after the jsonschema import
import tsTypesPlugin from '@adhd/apigen-plugin-ts-types';

// BEFORE (map, after line 20)
  jsonschema: jsonschemaPlugin,
// AFTER — add after the jsonschema entry
  'ts-types': tsTypesPlugin,
```

**No other wiring.** `plugin-registry.ts` derives `list-types`, `--type` help, and the
generate-only/run-capable split from the map — a plugin without `run()` automatically appears as
`(generate)` and is excluded from `run`/`run-registry`'s `--type` list (verified:
`generateOnlyTypeIds` / `runCapableTypeIds`).

### Modified: `entrypoint/apigen-cli/package.json`

- dependencies += `"@adhd/apigen-plugin-ts-types": "^0.0.1"` (match the generated plugin version;
  if the generator emits a different version, use `^<that>` so `@nx/dependency-checks`
  `checkVersionMismatches` passes).
- devDependencies += `"esbuild": "^0.25.12"` (version already present in `pnpm-lock.yaml`;
  keep whatever 0.25.x pnpm resolves).

---

## Emitter design (normative mapping table)

### Supported (round 1)

| JSON Schema | Emitted TS |
|---|---|
| `{ "type": "string" }` | `string` |
| `{ "type": "number" }` | `number` |
| `{ "type": "integer" }` | `number` |
| `{ "type": "boolean" }` | `boolean` |
| `{ "type": "null" }` | `null` |
| `{ "const": "cat" }` / `{ "const": 3 }` / `{ "const": true }` | `'cat'` / `3` / `true` |
| `{ "enum": ["a","b"] }` (string/number/boolean literals only) | `'a' \| 'b'`; `[true,false]` → `boolean` |
| `{ "type": "array", "items": S }` | `<S>[]` |
| `{ "type": "object", "properties", "required" }` | named `interface` (see members) |
| `{ "type": "object" }` no properties | `Record<string, unknown>` |
| `{}` (no `type`, no other construct) | `unknown` |
| `{ "oneOf": [...], "discriminator": { "propertyName", "mapping" } }` | discriminated union (below) |
| `{ "$ref": "#/$defs/User" }` / `"#/definitions/User"` | def name `User` (def emitted as named interface) |

**Object members:** for each `properties[k]`: required (in `required` array, or `required`
absent) → `k: <type>`; otherwise `k?: <type>`. Property names are emitted as-is when valid
identifiers, else `"k"` quoted (JSON-Schema allows any string key; quote non-identifier keys —
e.g. `'x-flag'`). `additionalProperties: false` is a constraint → ignored; `format` is advisory
→ ignored (base type emitted; decimal/date-time/int64 stay `string` — documented future work).
Nested object values become named support types `<parentTypeName><Pascal(prop)>`; array-of-object
element types use `<parentTypeName><Pascal(prop)>` too (the `[]` wraps it). `$ref` resolves only
against the schema's own `definitions`/`$defs` dict (hoisted from both input and output; merged,
later-wins on name clash); the def is emitted as an interface/type named by its key (sanitized).

**Discriminated union (the novel case — mirrors `_batch` shape from `BATCH_0.0.1.md` §1.1):**
given `oneOf: [B0, B1, …]` + `discriminator: { propertyName: 'kind', mapping: { 'cat': '#/oneOf/0', 'dog': '#/oneOf/1' } }`:

```ts
export type DemoRunTaskOutput = DemoRunTaskOutputCat | DemoRunTaskOutputDog;

export interface DemoRunTaskOutputCat {
  kind: 'cat';            // discriminant property RETAINED as a literal
  content: string;
}

export interface DemoRunTaskOutputDog {
  kind: 'dog';
  path: string;
  sizeBytes: number;
}
```

- Branch type name: `<unionTypeName><Pascal(mappingKey)>` (key from `discriminator.mapping`
  whose pointer ends `/oneOf/<i>`); if no mapping key matches branch `i`, fall back to
  `<unionTypeName>Branch<i>`.
- Branch emission is exactly the object-member logic above, so the branch's `kind` member comes
  from its own `properties.kind` (`const`/single-value `enum`) — the discriminant is **retained**,
  never stripped.
- The union type is emitted as `export type <unionName> = B0 | B1;` and referenced in the
  member/output position.
- **NEVER emit `any`, `unknown`, or bare `object` in this path.** A branch that is not an object
  schema (e.g. a primitive branch) → REJECT.

### Rejected (round 1 — throw `Error` with the construct name + fn + path)

| Construct | Error message fragment |
|---|---|
| `allOf` (any occurrence) | `allOf is not supported (round 1)` |
| `anyOf` (any occurrence) | `anyOf is not supported (round 1)` |
| `oneOf` WITHOUT `discriminator` | `oneOf without discriminator is not supported (round 1)` |
| `patternProperties` | `patternProperties is not supported (round 1)` |
| `additionalProperties` carrying a non-`false` value (a schema) | `additionalProperties schema is not supported (round 1)` |
| `$ref` not resolvable in the schema's own `definitions`/`$defs` | `unresolvable $ref: <ref>` |
| `enum` with non-literal (object/array/null) values | `non-literal enum value is not supported (round 1)` |
| `not`, `if`/`then`/`else`, `contains`, `propertyNames`, `unevaluatedProperties` | `<construct> is not supported (round 1)` |

Error prefix: `[apigen-plugin-ts-types]` and include `(fn: <fnName>, path: <property-path>)`.
The CLI surfaces the throw (commander async action rejection → nonzero exit).

---

## Registration & list-types confirmation

- `apigen list-types` derives from the map (`formatTypesList`): `ts-types` appears, capability
  `(generate)` only (no `run()`), sorted alphabetically. `run`/`run-registry`'s `--type` help
  will NOT include it. No `plugin-registry.ts` edit — verified by reading the module.
- The CLI build bundles the workspace plugin via tsconfig paths (same mechanism as
  `apigen-plugin-jsonschema`); `tsconfig.base.json` path entry is added by the generator.

---

## Scaffold command (MANDATORY — do not hand-create)

```bash
# from worktree root, AFTER `pnpm install` (nx must be available)
npx nx g @adhd/workspace-codegen-nx:plugin --name ts-types --group apigen --nxLayer logic --platform node --dry-run
# read the CREATE list, then re-run WITHOUT --dry-run
npx nx g @adhd/workspace-codegen-nx:plugin --name ts-types --group apigen --nxLayer logic --platform node
```

Expected: `packages/apigen/apigen-plugin-ts-types/` with `project.json` tags
`domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain`;
targets build/test/nx-release-publish (vite). `lint` is auto-attached by
`tools/nx-plugins/lint/plugin.js` because the generator emits `.eslintrc.json`. **BARE name**
`ts-types` — the generator composes `apigen-plugin-ts-types`; passing the full name double-prefixes.

**After scaffolding:** edit `package.json` (deps), then run `pnpm install` again so pnpm links the
new workspace package into `apigen-cli`'s node_modules before building/testing.

---

## Test plan (all default-running — NO env gates)

### A. Plugin unit tests — `packages/apigen/apigen-plugin-ts-types/src/test/emit-types.spec.ts`

Build `PluginInput` with `operations` populated (matching the real CLI shape) for most cases; one
test exercises the `pkg.schemas` fallback. Cases:

1. Primitives: `string`/`number`/`integer`/`boolean`/`null` → correct TS.
2. Object+required: `getUser` input `{ userId: string }` → `interface ... { userId: string; }`; a
   `name` not in `required` → `name?: string`.
3. Arrays: `items: { type: 'string' }` → `string[]`; array of objects → named element interface.
4. Enum: `enum: ['admin','user']` → `'admin' | 'user'`; `[true,false]` → `boolean`.
5. `$ref`: schema with `definitions.User` + `$ref: '#/definitions/User'` → emitted interface
   `User` + member `user: User`.
6. **Discriminated union (hand-built `_batch`-shaped schema):** `oneOf` (2 branches) +
   `discriminator { propertyName: 'operation', mapping: {...} }` → output contains the union
   `type`, one interface per branch, discriminant property retained, and **does NOT contain**
   `any` or `unknown`.
7. **sanitizeIdentifier load-bearing:** pkg id `dispatch-cli`, fn `validate` → emitted names
   `DispatchCliValidateInput` / `DispatchCliValidateOutput`; generated content contains no `-`
   inside any identifier position.
8. Rejections (each throws with the message fragment): `allOf`, `anyOf`, `oneOf` without
   discriminator, `patternProperties`, `additionalProperties` with a schema value, unresolvable
   `$ref`.
9. Fallback: `PluginInput` WITHOUT `operations`, composed-shaped `pkg.schemas` input
   (`properties.data` object wrapper) → emitted `Input` interface has the inner params, no `data`
   member.
10. Plugin object: `id === 'ts-types'`, `typeof generate === 'function'`, `run` undefined,
    `language === 'ts'`; one file per fn at `<pkgId>/<fnName>.ts` for a 2-fn input.
11. **Compile check + negative control:** `import { transform } from 'esbuild'`;
    `await transform(content, { loader: 'ts' })` resolves for every emitted file; **negative
    control** — take a valid emitted file, replace a sanitized type name with a bare hyphen splice
    (e.g. `DispatchCliValidateInput` → `DispatchCli-ValidateInput`), assert
    `await expect(transform(bad, { loader: 'ts' })).rejects.toThrow()`. (Teeth: revert the
    emitter's sanitize step → the real emitted file fails the same transform.)

### B. Consumer-path test — `entrypoint/apigen-cli/src/test/e2e/ts-types.spec.ts` (DEFAULT-RUNNING)

Mirrors `real-consumer.spec.ts` spawn pattern; the CLI `test` target already `dependsOn: ["build"]`.

- **Paths:** `REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')`;
  `BUILT_BIN = REPO_ROOT/entrypoint/apigen-cli/dist/index.js`;
  fixture `entrypoint/apigen-cli/src/test/fixtures/ts-types-source.ts`;
  `tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ts-types-'))` (+ `afterEach rmSync`).
- **list-types:** spawn `node <BUILT_BIN> list-types` → assert exit `0` and stdout contains
  `ts-types` and `(generate)`.
- **generate:** spawn `node <BUILT_BIN> generate --source <fixture> --type ts-types
  --namespace demo-api --out-dir <tmpDir>` with `cwd: REPO_ROOT`, stdio captured. Await exit;
  assert `code === 0` (trust the exit code, not stdout). If the process fails, the assertion
  message must include captured stderr.
- **Content:** read `<tmpDir>/demo-api/<fn>.ts` files; assert per-fn named types
  (`DemoApiGetUserInput`, etc.), the discriminated-union fn's output contains the union type +
  branch interfaces + retained discriminant and NO `any`/`unknown` in that file.
- **Compile check:** for every emitted `.ts`, `await transform(content, { loader: 'ts' })`
  resolves (esbuild imported from `entrypoint/apigen-cli`'s devDeps). Missing esbuild must make
  the test FAIL LOUDLY (import error), never silently skip.
- **Negative control (teeth):** also mutate one emitted file with a hyphen splice and assert the
  same transform rejects — proving the check is not a no-op. (Negative control is authoritative
  in the plugin test; here it guards the CLI-output path.)

### C. Fixture — `entrypoint/apigen-cli/src/test/fixtures/ts-types-source.ts`

Named exports only: `getUser(userId: string): Promise<{ id: string; name?: string }>`,
`listUsers(role: 'admin' | 'user'): Promise<string[]>`, and
`runTask(task: Task): Promise<Task>` with
`type Task = { kind: 'text'; content: string } | { kind: 'file'; path: string; sizeBytes: number }`.

**Implementation step (do first, before writing assertions):** run `extract()` on the fixture
(small scratch test or `node -e` under the plugin's vitest) and CONFIRM the `runTask` op's
`input`/`output` schema carries `oneOf` + `discriminator`. The morph-walk `detectDiscriminator`
path is the target (inline anonymous union with a shared literal-tag property). If extraction
produces `oneOf` WITHOUT a discriminator, adjust the fixture to force the inline path (e.g.
inline the union in the parameter position: `task: { kind: 'text'; content: string } | { kind:
'file'; path: string; sizeBytes: number }`). If it STILL lacks a discriminator, keep the
consumer test's union assertions on the simple fns and rely on plugin unit test 6 (hand-built
`_batch` schema) as the authoritative union proof — and say so in the PR. The emitter contract is
unchanged either way.

---

## Docs updates

### `docs/apigen/SPEC.md` — insert a new §6.1 after §6 (Typing & validation)

```markdown
### 6.1 `ts-types` — typed TS client codegen *(new output target)*

`apigen generate --source ./api.ts --type ts-types --out-dir ./client` emits one `.ts` type-declaration
file per exported function (named `interface`/`type`, never inline anonymous `object`), derived from the
function's JSON-Schema IR (§4). Named types are package-qualified so output from several packages
collides-free in one consumer. Discriminated unions (`oneOf` + `discriminator`, the `_batch` shape) emit a
named union with per-branch interfaces retaining the discriminant. Round-1 scope: primitives, objects with
`required`/optional, arrays, enums, `$ref`/`definitions`, `const`, and discriminated `oneOf`; constructs
outside that subset (`allOf`/`anyOf`, untagged `oneOf`, `patternProperties`, `additionalProperties`
schemas) fail with a clear error rather than degrading. The `data` envelope is dissolved (§4); `format`
annotations are emitted as their base type (decimal/int64 stay `string`) in round 1. Package:
`@adhd/apigen-plugin-ts-types`.
```

### `entrypoint/apigen-cli/AGENTS.md`

- Plugin reference table: add row
  `| ts-types | TS | No | Yes | @adhd/apigen-plugin-ts-types |`.
- Do NOT add `ts-types` to the `run` command's `--type` list (generate-only).
- Optionally one line in the `generate` section noting the new id.

---

## Independent segments & execution order (follow exactly — one bounded pass)

**Segment 0 — environment (prereq for everything):**
`pnpm install` from the worktree root. The worktree has NO `node_modules`. The root
`package.json` pins `"packageManager": "pnpm@8.15.9"` and a `pnpm-lock.yaml` exists — pnpm is the
authoritative manager (the worktree AGENTS.md's "corepack yarn install" text predates the
yarn→pnpm migration; do not run yarn). This install MUST happen before any lint/dependency-checks
(BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001).

**Segment 1 — scaffold + deps:**
generator (dry-run then real) → read generated files → edit plugin `package.json` (engine-naming
dep + esbuild devDep) → `pnpm install` again (links the workspace package) → overwrite
`src/index.ts` re-export.

**Segment 2 — emitter + plugin (the core):**
write `src/lib/emit-types.ts` → `src/lib/plugin.ts` → unit tests `src/test/emit-types.spec.ts` →
README + CHANGELOG.

**Segment 3 — CLI wiring:**
`entrypoint/apigen-cli/src/index.ts` (import + map line) → `entrypoint/apigen-cli/package.json`
(deps) → fixture `ts-types-source.ts` → verify extraction of the union (Segment C note) →
consumer test `src/test/e2e/ts-types.spec.ts`.

**Segment 4 — docs:**
`docs/apigen/SPEC.md` §6.1 → `entrypoint/apigen-cli/AGENTS.md` row.

**Segment 5 — verify (below), then commit** with Conventional Commits
(`feat(apigen): add ts-types JSON-Schema→TS codegen plugin` + a second commit for docs if split;
scope = library name per AGENTS.md §12). Never `git add -A`; stage explicit paths.

---

## Verification plan (trust exit codes, never `grep` "passed")

```bash
cd /Users/nix/dev/node/adhd/.worktrees/chain-20260802-183630-6422a0
pnpm install                                  # once, FIRST
# … implement …
pnpm install                                  # after package.json edits (links new workspace pkg)
npx nx build apigen-plugin-ts-types           # exit 0
npx nx test apigen-plugin-ts-types            # exit 0 (runs lint + ^build first per targetDefaults)
npx nx lint apigen-plugin-ts-types            # exit 0
npx nx build apigen-cli                       # exit 0 (CLI now bundles the new plugin)
npx nx test apigen-cli                        # exit 0 (includes the new e2e ts-types.spec.ts; lint+build run first)
npx nx lint apigen-cli                        # exit 0
```

Notes: `lint` pulls in `sync-deps` (targetDefault) and `@nx/dependency-checks` — the
`esbuild`/`@adhd/*` declarations above are what keep it green. If `checkObsoleteDependencies`
flags `esbuild`, keep it (it is genuinely imported by tests). If any apigen-cli suite failure is
unrelated to this change, report it with evidence (stderr) rather than declaring it pre-existing.
Per AGENTS.md, run `gitnexus_impact` before editing `src/index.ts`'s map and
`gitnexus_detect_changes` before committing.

---

## Open questions / risks for implementer & reviewer

1. **Union extraction (highest risk):** whether the fixture's TS discriminated union extracts to
   `oneOf`+`discriminator` through the real extractor is EMPIRICAL — verify first (Segment C
   note). The plugin unit test with the hand-built `_batch` schema is the authoritative union
   proof regardless; the CLI fixture is the bonus end-to-end proof. Reviewer: check the PR
   states which path held.
2. **esbuild devDep promotion:** a package.json change; esbuild is already in the lockfile. If
   the reviewer reads AGENTS.md's external-tool-approval rule strictly, this is flagged as a
   promotion, not an install. The FEATURE itself adds zero runtime deps (hand-rolled emitter).
3. **CLI rejection exit code:** a rejected construct surfaces as a commander async rejection
   (nonzero exit + stderr). Only unit tests assert the throw; the consumer test does not drive a
   rejection fixture — if you add one, assert `code !== 0`, not a specific code.
4. **`checkVersionMismatches`:** the CLI's `@adhd/apigen-plugin-ts-types` range must cover the
   generated plugin version; keep them in lockstep.
5. **Per-fn files have no barrel:** intentional (scope); consumers import per-fn modules. Future
   work if a barrel is wanted.
6. **`format` ignored:** decimal/int64/date-time emit as `string` — documented in SPEC §6.1 as
   round-1 behavior; a later round can map to branded/nominal types.
