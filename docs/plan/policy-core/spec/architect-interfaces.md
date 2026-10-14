# Interface specification: policy client, policy schema, and `@adhd/policy`

Status: draft for owner review. Two packages: the library `packages/policy/policy-core-client` (`@adhd/policy-core-client`) and the apigen wrapper `entrypoint/policy` (bin `adhd-policy`). Paths below that read `entrypoint/policy/src/{spec,core,service}` are the client package's `src/` once split. Companion to `architect-spec.md` (behaviors; IDs like `CL-02` refer to it). The policy library is host-agnostic: it authenticates no one, owns no session, stores no state and confines no process (SC-01 to SC-08). Foreign servers and commands are reached by apigen sources, not by policy code: `architect-spec-sources.md`, `architect-interfaces-sources.md`. The apigen policy Layer plugin is a separate package: `architect-spec-layer.md`, `architect-interfaces-layer.md`. The sandbox and the example hosts are separate consumers: `architect-interfaces-sandbox.md`, `architect-spec-sandbox.md`, `architect-spec-examples.md`. The library layers (`spec`, `core`, `service`) import none of them and none of `architect-demo-v4.md` (D4, the policy shape). Nothing here creates a package: BO-02 still requires recorded human approval, and names are placeholders (BO-05).

Repo conventions applied: shared interfaces are prefixed `I`; imports use workspace package names; dependencies flow down only; no subprocess in the unit `test` lane (subprocess and real-server tests are `*.e2e.test.ts` in the `e2e` lane, ADR-0009); tests drive the way a consumer does.

Verified facts used: `@adhd/data-query-engine` exports `DataView`, `Query`, `QueryValidationError` and the `QueryExpression` type (`packages/data/data-query-engine/src`); `Environment` (`@adhd/environment`, types in `@adhd/environment-base-spec`) is constructed as `new Environment(project, spec, options)` with a code-defined `EnvironmentSpec<T>` (`envPrefixOverride`, `namespaces`, `dirs`, `files`, `config` entries with `type`, `env`, `default`, `description`, `enum`) and scopes `system | global | project`; `entrypoint/backlog/src/env.ts` is the in-repo precedent. apigen's CLI target is `@adhd/apigen-plugin-cli-output` (`--type cli`, `cliPlugin.run({options:{argv}})`); `entrypoint/backlog/src/{api,cli,server}.ts` is the precedent for one operation set mounted live on CLI, HTTP and MCP. **Unverified:** that `DataView` can evaluate one expression against one row cheaply and synchronously (QE-08). If it cannot, a thin `matches(row, expr)` adapter is the only code allowed to change (section 4.3).

## 1. Packages: client library and apigen wrapper

Direction: a pure library (`@adhd/policy-core-client`: `spec`, `core`, `service`, `createDecider`) and a wrapper (`entrypoint/policy`: three apigen entry files and the `run` and `serve` verbs over apigen sources with the policy Layer loaded). The client is a light client with no knowledge of MCP, processes, agent-mcp, a sandbox or any authentication mechanism (SC-02). The entry files project its operations through apigen with no customization. Static gating and `.mcp.json` wrapping come from apigen's `bin` and `remote` sources (SV-14, SV-20), not from hand-written shells.

| Item | Value |
|---|---|
| Path / name | client `packages/policy/policy-core-client` (`@adhd/policy-core-client`, tier core, `layer:logic`, `platform:node`); wrapper `entrypoint/policy` (names pending BO-05) |
| Tags | `layer:entrypoints`, `platform:node`, `access:public` |
| Runtime dependencies | Client: `@adhd/data-query-engine`, `@adhd/environment`, a YAML parser. Wrapper: the client, apigen packages and MCP/HTTP server libraries, used only by the entry files and never loaded by the client root (SV-17) |
| Depended on by | Any consumer: a program (library), a terminal (CLI), an MCP host (MCP server or `serve`), anything that speaks HTTP |

### 1.1 The entrypoints

| Entrypoint | How you reach it | What it is | Code it contains |
|---|---|---|---|
| Programmatic client | `import { evaluate, ... } from '@adhd/policy-core-client'` | The operation set (section 5), `createDecider` and the types. The pure core is a folder (`src/core`), not an import path | All behavior |
| CLI | bin `adhd-policy` (owner-named) | `apigen` cli-output over the operation set, plus `run <source>` and `serve <source>` with the policy Layer preloaded (IF-11) | An entry file that selects the plugin (SV-03) |
| MCP server | bin name pending | `apigen` mcp plugin over the operation set; stdio; started only by an explicit command (VR-06) | An entry file (SV-03) |
| HTTP server | bin name pending | `apigen` fastify plugin over the operation set; loopback; started only by an explicit command (VR-06) | An entry file (SV-03) |
| Static gate | `adhd-policy run bin:<command> --spec <file> -- [args]` | An operation of the `bin` source evaluated by the Layer (VR-02, SV-20); no server | None: apigen source plus Layer |
| `.mcp.json` wrap | `adhd-policy serve <source> --spec <file>` | stdio MCP host over a `bin:` or `remote:` source with the Layer loaded (VR-03, SV-14); the Layer calls the client in-process | None: apigen source, host and Layer |

The client has one importable path, its root (SV-16). The root exports the operation set, `createDecider` (satisfies the Layer plugin's port structurally, SV-18) and the spec types. Importing the root starts nothing (SC-06). The JSON Schemas ship as files under `schema/`. The `exports` map lists the root and `package.json` and closes every other path.

The wrapper contains no proxy code. A foreign upstream's tool or command set is discovered at run time, which apigen's `remote` and `bin` sources handle by extracting to the IR (`architect-spec-sources.md`); the policy Layer then sees them as ordinary operations. Only the entry files, `run`, `serve` and `mcp-json` exist in the wrapper, and all are held to SV-03, SV-15 and SC-07.

An entry file is on the order of a few lines: build the lazy context, hand the operation module and options to the plugin, start. It adds no command, route, tool, flag, validation or authorization. Anything that looks like customization (auth, rate limits, tracing, the exposed subset) is apigen configuration set out of source (include/exclude, `--use`), per apigen Tenet 1.

### 1.2 Layers inside the package

```
spec  <-  core  <-  service (api.ts, ports, env wiring)  <-  entry files (cli, mcp, http)
```

| Layer | May import | Must not import |
|---|---|---|
| `spec` | nothing | everything else |
| `core` | `spec`, `@adhd/data-query-engine` | `service`, entry files, `@adhd/environment`, apigen, any server library, `process.env`, `node:fs` |
| `service` | `spec`, `core`, `@adhd/environment`, `node:fs` (layer files only) | entry files, apigen, server libraries |
| entry files | `service` (the operation module), apigen plugins, server libraries | `core` internals |
| `wrap` (`mcp-json`) | `service` (the operation module `api.ts` only) | `core` internals, other entry files |

A lint rule (`no-restricted-imports` zones) and `test/architecture/layers.spec.ts` enforce this (SC-07). The root export re-exports `service`, the spec types, `createDecider`, so loading it pulls in no apigen, ts-morph, MCP SDK or server code (SV-13, IN-12). The apigen Layer plugin is a separate package with no import edge to this one in either direction; only this package's tests import it (LP-02).

### 1.3 Repo-rule conformance

- Reusable logic lives in `packages/policy/policy-core-client`; the entrypoint stays thin (AGENTS.md rule 8.2). No deviation is needed.
- BO-02 approval for both packages must be recorded; the new domain `policy` is added to `.adhd/workspace.json` first. Scaffold the client with the `core` generator and the wrapper with the `entrypoint` generator (`--name policy --nxLayer entrypoints --platform node --access public --publish true`), dry-run first.
- `platform:shared` is not claimed: the client is node-only. If browser use of `spec` and `core` is wanted, that is a further split trigger.

## 2. Policy document schema (source, JSON; YAML parses to this)

Delivered as `entrypoint/policy/src/spec/schema/policy.schema.json` (JSON Schema 2020-12) with the types below generated from or hand-checked against it by a test.

```typescript
// entrypoint/policy/src/spec/policy.ts
export type PolicyVersion = 1;

/** Attribute kinds. `name` is a single string; `names`/`paths` are string lists. */
export type AttributeKind = 'name' | 'names' | 'paths' | 'number';

export type AttributeValue = string | number | readonly string[];

/** The facts about a caller that a consumer supplies (AT-01). Optional everywhere (AT-09). */
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** `attributes:` block. Keys are attribute names. The whole block is optional. */
export type IAttributeDecl = Readonly<Record<string, AttributeKind>>;

/** `runtime:` block. The consumer-supplied fields the policy reads (RT-02). */
export type IRuntimeDecl = Readonly<Record<string, 'number' | 'name'>>;

/** Consumer-supplied, read-only (RT-01). */
export type IRuntimeValues = Readonly<Record<string, number | string>>;

/** One `defaults` rule. Matched against the supplied attributes; the last matching rule that sets an attribute wins (LY-01). */
export interface IDefaultsRule {
  /** Filter over the supplied attributes, same syntax as `context`. Omitted = every caller (LY-02). */
  readonly where?: FilterExpression;
  /** Values this rule sets. An explicit empty value stops inheritance (LY-04). */
  readonly set: Attributes;
}

export type Effect = 'allow' | 'ask' | 'deny';

/** A query-engine expression (QE-01). Placeholders `$attributes.*` appear as string leaves. */
export type FilterExpression = Readonly<Record<string, unknown>>;

export interface IPermission {
  /** Tool name, list, or trailing-wildcard pattern (`files.*`). */
  readonly tool: string | readonly string[];
  /** Default `allow` (PM-05). */
  readonly effect?: Effect;
  /** Filter over `{ ...attributes, runtime }` (FX-05). */
  readonly context?: FilterExpression;
  /** Filter over the tool-call arguments (and `child.*` for child-creating tools). */
  readonly args?: FilterExpression;
  /** Argument values forced onto an allowed call. */
  readonly set?: Readonly<Record<string, unknown>>;
}

export interface IPolicyDocument {
  readonly version: PolicyVersion;
  readonly attributes?: IAttributeDecl;
  readonly runtime?: IRuntimeDecl;
  readonly defaults?: readonly IDefaultsRule[];
  readonly permissions: readonly IPermission[];
}
```

Schema rules enforced by the JSON Schema (structural) and by `compile` (semantic, section 3):
- `version` required. Unknown top-level keys are an error (no silent ignore).
- `permissions[].tool` must be non-empty; `effect` is one of three values; `set` keys must be argument names.
- Every attribute named by `where`, `context`, `$attributes.` placeholders, `set`, `grant` or `only` must be declared in `attributes`; every `runtime.` field read must be declared in `runtime` (PD-09, RT-02). A document that names none has neither block.
- `runtime` cannot appear in `defaults[].set`, `defaults[].where`, `grant` or `only` (RT-01). `where` may name only declared attributes (LY-07).

### 2.1 Layer inputs

```typescript
export type LayerName = 'global' | 'project' | 'local';

export interface ILayerInput {
  readonly name: LayerName;
  /** Where it came from, for error messages and `explain`. */
  readonly source: string;
  readonly document: unknown; // validated against the schema by compile
}
```

Layer rules (LY-*): `permissions` and `defaults` concatenate global, then project, then local; for defaults the last matching rule wins per attribute (LY-01). Shared attributes (`shared_*`) and absolute paths may be set only by `global` and `local` (LY-05). `local` may add `allow` entries only through the ask flow (AK-04); any layer's `deny` wins (PM-09).

### 2.2 Narrowing request

```typescript
export interface INarrowRequest {
  /** Added to inherited values (union), per attribute (MG-04). */
  readonly grant?: Attributes;
  /** Must lie within the add-step result; replaces it (MG-05). */
  readonly only?: Attributes;
  /** Supplied attributes of the child, matched by `defaults[].where` (for example `{ team: 'payments' }`). Final: `grant` and `only` cannot change them (AT-04). */
  readonly attributes?: Attributes;
}
```

## 3. Compiled policy schema

Delivered as `entrypoint/policy/src/spec/schema/compiled.schema.json`. This is what a deployer may store as a precompiled artifact and what consumers load (CL-06, CL-13).

```typescript
// entrypoint/policy/src/spec/compiled.ts
export interface ICompiledPolicy {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  /** sha256 over canonical JSON of the sorted layer inputs + compilerVersion (CC-01). */
  readonly inputHash: string;
  /** sha256 over this object with `contentHash` omitted; verified on load (CL-13). */
  readonly contentHash: string;
  readonly attributes: Readonly<Record<string, AttributeKind>>;
  readonly runtime: IRuntimeDecl;
  /** `defaults` rules in evaluation order: layer order, then file order (LY-01). */
  readonly defaults: readonly ICompiledDefaultsRule[];
  /** Permissions in layer order, pre-indexed for lookup (below). */
  readonly permissions: readonly ICompiledPermission[];
  /** tool name -> indexes into `permissions`; patterns in `patterns`. */
  readonly index: {
    readonly exact: Readonly<Record<string, readonly number[]>>;
    readonly patterns: readonly { readonly prefix: string; readonly rules: readonly number[] }[];
  };
  /** Attributes for which a narrowing check exists on child-creating tools (NR-04 coverage set). */
  readonly narrowingCovered: Readonly<Record<string, readonly string[]>>;
}

export interface ICompiledDefaultsRule {
  readonly id: string;                       // `<layer>:<n>`, kept for provenance in explain (EX-01)
  readonly layer: LayerName;
  readonly source: string;
  readonly where: FilterExpression | undefined;
  readonly set: Attributes;
}

export interface ICompiledPermission {
  readonly id: string; // `<layer>:<n>` stable id used in decisions and logs
  readonly layer: LayerName;
  readonly tools: readonly string[];
  readonly effect: Effect;
  readonly context: FilterExpression | undefined;
  /** Placeholders pre-parsed to paths so substitution is a lookup, not a parse. */
  readonly args: FilterExpression | undefined;
  readonly placeholders: readonly string[]; // e.g. ['attributes.read_roots']
  readonly set: Readonly<Record<string, unknown>> | undefined;
  readonly usesWithin: boolean;
  /** True when `context` reads `runtime.*`; drives RT-09 and the `verify` warning. */
  readonly readsRuntime: boolean;
}
```

Canonicalization: keys sorted, no insignificant whitespace, UTF-8, so equal input gives byte-equal output (CL-05). `compile` never reads the clock, environment or filesystem; the caller reads files and passes `ILayerInput[]`.

## 4. Core interface (`src/core`, pure; a folder, not an import path)

### 4.1 Public API

```typescript
// entrypoint/policy/src/core/index.ts
export function compile(layers: readonly ILayerInput[], options?: ICompileOptions): ICompileResult;
export function loadCompiled(json: unknown): ICompiledPolicy;           // verifies schema, hashes (CL-13); internal to the client, not a root export (D-25)
export function evaluate(
  policy: ICompiledPolicy,
  call: IToolCall,
  attributes?: Attributes,
  runtime?: IRuntimeValues,
): IDecision;
export function narrow(
  policy: ICompiledPolicy,
  parent: Attributes,
  request: INarrowRequest,
): INarrowResult;
export function resolve(policy: ICompiledPolicy, attributes?: Attributes): IResolved;   // defaults applied to the supplied attributes
export function explain(
  policy: ICompiledPolicy,
  call: IToolCall,
  attributes?: Attributes,
  runtime?: IRuntimeValues,
): IExplanation;
```

`call` names the tool call, to avoid confusion with the permission field `context` (which filters the attributes). If the owner prefers `context`, rename the parameter only.

### 4.2 Types

```typescript
export interface ICompileOptions {
  /** Defaults to the package version. Part of the memo key. */
  readonly compilerVersion?: string;
}

export interface IPolicyIssue {
  readonly code:
    | 'schema' | 'unknown-operator' | 'unsupported-placeholder' | 'undeclared-attribute'
    | 'undeclared-runtime' | 'uncovered-narrowing' | 'layer-violation' | 'duplicate-id'
    | 'runtime-without-provider';
  /** JSON path into the offending layer document (CL-04). */
  readonly path: string;
  readonly layer?: LayerName;
  readonly message: string;
}

export type ICompileResult =
  | { readonly ok: true; readonly policy: ICompiledPolicy; readonly warnings: readonly IPolicyIssue[] }
  | { readonly ok: false; readonly errors: readonly IPolicyIssue[] };

export interface IToolCall {
  /** Qualified tool name, as written in the policy's `tool` keys. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface IDecision {
  readonly effect: Effect;
  /** Forced argument values to merge into the forwarded call (CL-07). */
  readonly set: Readonly<Record<string, unknown>>;
  /** Permission ids that matched, in evaluation order. */
  readonly matched: readonly string[];
  /** Present when effect is `deny`: a stable code + human reason. */
  readonly denial?: {
    readonly code: 'explicit-deny' | 'no-match' | 'eval-error' | 'runtime-unavailable';
    readonly reason: string;
  };
}

export type INarrowResult =
  | { readonly ok: true; readonly child: Attributes }
  | { readonly ok: false; readonly variable: string; readonly rule: string; readonly reason: string };

export interface IResolved {
  readonly attributes: Attributes;
  /** Where each effective value came from: `supplied` or a defaults rule id (EX-01). */
  readonly provenance: Readonly<Record<string, string>>;
}

export interface IExplanation {
  readonly decision: IDecision;
  readonly considered: readonly {
    readonly id: string;
    readonly applicable: boolean;
    readonly contextMatched?: boolean;
    readonly argsMatched?: boolean;
    readonly substituted: FilterExpression | undefined;
  }[];
}
```

### 4.3 Engine adapter (the only module that imports the engine)

```typescript
// entrypoint/policy/src/core/engine/matches.ts
/** True if `row` satisfies `expression` under the query engine's semantics (QE-01, QE-06). */
export function matches(row: Readonly<Record<string, unknown>>, expression: FilterExpression): boolean;
/** Validates that every operator in `expression` is supported (QE-05). Returns the offending paths. */
export function validateExpression(expression: FilterExpression): readonly string[];
```

Resolution procedure in `evaluate` (CL-08, PM-*, QE-03):
1. Select permissions whose `tools` match `context.tool` (exact index, then patterns).
2. Resolve the effective attributes (`resolve`), build the context row `{ ...attributes, runtime }`, and keep permissions whose `context` matches (omitted = true; an absent attribute compares false, AT-10). A permission with `readsRuntime` and no `runtime` makes the call deny `runtime-unavailable` (RT-09).
3. For each remaining permission, substitute `$attributes.*` in `args`, then `matches(args, context.args)`.
4. Resolve: any matching `deny` -> deny; else any `ask` -> ask; else any `allow` -> allow; else deny `no-match`.
5. Merge `set` from all matching allow/ask permissions; conflicting `set` values for one key are a compile warning and deny at runtime.
6. Any thrown error becomes deny `eval-error` (FC-01).

`_within` is implemented in `matches` as a rewrite (QE-04) until or unless the engine gains it.

### 4.4 Errors

```typescript
export class PolicyLoadError extends Error { readonly code: 'schema-version' | 'hash-mismatch' | 'malformed' }
export class PolicyCompileError extends Error { readonly issues: readonly IPolicyIssue[] }
```
`compile` returns results (never throws on user input). `loadCompiled` throws `PolicyLoadError` (CL-13). `evaluate` never throws; it returns deny.

### 4.5 Compiled-policy memo (in memory; no disk cache)

```typescript
// entrypoint/policy/src/core/memo/memo.ts
export interface IPolicyMemo {
  /** Hit: same input hash, return the stored compile with no parse or compile (CC-03). Miss: compile, store, return. */
  load(layers: readonly ILayerInput[]): ICompileResult;
}

export function createPolicyMemo(options?: ICompileOptions): IPolicyMemo;
```
Entries are immutable and keyed by the input hash and compiler version (CC-01, CC-02, CC-05). `compile` produces the `ICompiledPolicy` artifact. `loadCompiled` is internal to `@adhd/policy-core-client` and is not exported from the package root (D-25); the client calls it, with CL-13 failure semantics, wherever it reads a precompiled artifact (CC-04, CL-13).

### 4.6 Layer loading (kept out of `compile`; implemented in `service`)

```typescript
export interface ILayerSource {
  /** Returns the existing layers in global, project, local order, parsed to JSON. */
  load(): Promise<readonly ILayerInput[]>;
}
```
The entrypoint implements it with `Environment` (discovery order: flag, walk-up `workspace-policy.yaml`, user default, built-in; D1) and a YAML parser. Tests use an in-memory implementation.

## 5. Service layer: the operation set (`src/service/api.ts`)

This one file is the product's surface. Its exports are the programmatic client, and apigen projects them unchanged to the CLI, MCP and HTTP entrypoints (SV-02). Parameters and results are JSON-serializable (SV-05). Every `attributes` and `runtime` parameter is optional (AT-09).

```typescript
// src/service/api.ts  -- every export is an operation `adhd-policy <kebab-name>` / MCP tool / HTTP route
export async function compile(input: { layers?: ILayerInput[] }): Promise<ICompileSummary>;
export async function verify(input: { layers?: ILayerInput[] }): Promise<IVerifyReport>;

export async function resolve(input: { attributes?: Attributes }): Promise<IResolved>;
export async function narrow(input: { parent?: Attributes; request: INarrowRequest }): Promise<INarrowOutcome>;

export async function evaluate(input: { tool: string; args?: Record<string, unknown>; attributes?: Attributes; runtime?: IRuntimeValues }): Promise<IDecision>;
export async function check(input: { tool: string; args?: Record<string, unknown>; attributes?: Attributes; runtime?: IRuntimeValues }): Promise<IDecision>; // ApiError permission_denied on deny
export async function explain(input: { tool: string; args?: Record<string, unknown>; attributes?: Attributes; runtime?: IRuntimeValues }): Promise<IExplanation>;

export async function show(input: { attributes?: Attributes }): Promise<IEffectivePolicy>;
export async function doctor(): Promise<IDoctorReport>;
/** Draft policy from a plain-data view of a foreign source's operations (SRC-11, CL-14). */
export async function draft(input: { operations: IDraftOperation[]; options?: IDraftOptions }): Promise<IDraftPolicy>;

export type INarrowOutcome =
  | { ok: true; child: Attributes }
  | { ok: false; variable: string; rule: string; reason: string };
```

Notes:
- `evaluate` is the decision point every consumer calls. With `runtime` values in the input it is a pure function of its inputs. With none and an `IRuntimeProvider` in the context, it calls `observe` once and decides on the returned values (RT-08, SV-07). A permission that reads `runtime` with neither denies `runtime-unavailable` (RT-09).
- `narrow` returns child attributes or a denial naming the attribute and rule (EX-04). It issues no reference and stores nothing (DL-01).
- There is no operation that writes a policy layer file (IN-07). The "allow always" write of the ask flow (AK-04) uses a local-layer path configured by the deployer, outside the operation set.
- `show` and `explain` reveal policy to anyone who can call them; exposure is a deployment decision (SV-11).

### 5.1 Service context and ports (consumer-supplied; none shipped)

```typescript
export interface IPolicyCtx {
  readonly policy: () => Promise<ICompiledPolicy>;   // memoized compile of the configured layers
  readonly runtime?: IRuntimeProvider;               // consumer-supplied (SC-03)
  readonly audit?: IAuditSink;                       // consumer-supplied (AU-01)
  readonly now: () => number;                        // injected clock for deterministic tests
}

export interface IRuntimeProvider {
  /**
   * Records this call and returns the post-observation runtime values atomically (RT-08).
   * `scope` is a consumer-chosen opaque key (a session id, a token subject, anything).
   * Safe across processes only if the provider makes it so (RT-07).
   */
  observe(input: { scope?: string; tool: string; attributes: Attributes }): Promise<IRuntimeValues>;
}

export interface IAuditSink { record(entry: IAuditEntry): void }  // redacted, structured (AU-01)

export function createPolicyCtx(env: Environment, ports?: { runtime?: IRuntimeProvider; audit?: IAuditSink }): IPolicyCtx;   // the only place settings are read (10.2)
```
The context is built lazily (a thunk), so `--help`, argument errors and unknown commands load nothing (IN-14). Tests build `IPolicyCtx` directly with in-memory ports; no environment is needed. Over MCP or HTTP a caller cannot inject a provider, so it passes `runtime` values in the input and the operator owns what those values mean.

### 5.2 Entry files (the whole of each)

```typescript
// src/entry/cli.ts   (bin `adhd-policy`)  -> apigen cli-output  run({ options: { argv } }) over `service/api`, plus the `run` and `serve` source verbs with the policy Layer preloaded
// src/entry/mcp.ts   (bin name pending)   -> apigen mcp plugin   serve over `service/api`, stdio; explicit start only
// src/entry/http.ts  (bin name pending)   -> apigen api-fastify  serve over `service/api`, 127.0.0.1; explicit start only
```
Each: build the lazy `IPolicyCtx` thunk, import the operation module, call the plugin, map nothing. The IR is baked at build for all three (10.3).

### 5.3 CLI surface (derived, not authored)

Commands exist because operations exist: `adhd-policy compile`, `verify`, `evaluate`, `check`, `explain`, `resolve`, `narrow`, `show`, `draft`, `doctor`. Flags, help, validation and exit codes (`invalid_argument` -> 2, `permission_denied` -> 3, `not_found` -> 4, `internal` -> 1, per `CLI_EXIT_CODE`) come from apigen. There is no hand-written command except the source verbs `run`, `serve` and `mcp-json` (SV-03, SV-20, SV-14). Until apigen has an approval-required result, `check` reports `ask` as `permission_denied` (OD-16).

### 5.4 Environment settings

See section 10.2 (`policyEnvironmentSpec`).

## 6. Consumers (the library imports none of them)

- The **apigen sources** `remote` and `bin` (`architect-spec-sources.md`, `architect-interfaces-sources.md`) let any foreign MCP server, API or command be served with the policy Layer in front. They belong to apigen (OD-32), not to this package.
- A **sandbox launcher** is a separate package. It reads effective attributes from `resolve` and applies its own configuration (RS-01) by implementing apigen's process-launcher port (`IProcessLauncher`). Specified in `architect-spec-sandbox.md` and `architect-interfaces-sandbox.md`.
- The **apigen policy Layer plugin** (`architect-spec-layer.md`) is a separate package that lets any apigen-served operation set consult `createDecider`. It is not part of this package and neither imports the other.
- An **auth layer** is any package or service that authenticates a caller and supplies attributes (SC-03). Policy has no dependency on it; its catalog of mechanisms is `research-auth-mechanisms.md`.
- **Hosts** (agent-mcp, any MCP client, a CI job) call `check` or `evaluate` directly, for example from a pre-tool hook. Example uses are in `architect-spec-examples.md`.

## 7. File structure (client package: `src/{spec,core,service}`; wrapper package: `src/{entry,mcp-json}`, `bin/`)

Best practice applied: one folder per layer (1.2), a barrel per public entry, tests mirror source and are separated by lane, shared fixtures, and no cross-layer reaching.

```
entrypoint/policy/
  package.json                 # exports map: root only (SV-16), bins: adhd-policy (+ server bins, names pending)
  project.json  tsconfig*.json  eslint.config.mjs  vite.config.ts  vitest.e2e.config.ts
  bin/adhd-policy.js
  README.md  AGENTS.md  CHANGELOG.md
  docs/                        # usage (D1), policy reference, per-interface attribute provision tables (LC-08), deployment notes (SV-10, SV-11)
  schema/                      # emitted JSON Schemas (generated from src/spec; checked in)
  dist/api.ir.json             # baked at build (10.3); not checked in
  src/
    index.ts                   # root export = service operations + spec types
    spec/
      index.ts  policy.ts  compiled.ts
      schema/{policy.schema.json,compiled.schema.json}
    core/                      # pure, no I/O
      index.ts
      compile/{compile,layers,defaults,narrowing,canonical,hash}.ts
      evaluate/{evaluate,select,substitute,resolve,explain}.ts
      attributes/{narrow,merge,resolve}.ts
      engine/{matches,within,validate}.ts      # only files that import the query engine
      memo/{memo,key}.ts
      errors.ts
    service/
      index.ts
      api.ts                                   # THE operation set (section 5)
      ctx.ts  decider.ts  ports.ts             # IRuntimeProvider, IAuditSink (types only)
      config/{env-spec,layer-source,yaml}.ts   # the only code that touches @adhd/environment and YAML
    entry/{cli,mcp,http}.ts                    # a few lines each; no behavior (SV-03)
    wrapper/                                   # wrapper package only; no proxy code (SV-14/SV-15)
      attributes-source.ts                     # --adhd-attributes / ADHD_POLICY_ATTRIBUTES / @file (LC-01, LC-04, VR-09)
      mcp-json/{init,undo}.ts                  # WM-04
      sources.ts                               # wires run/serve to apigen sources with the Layer preloaded
  test/
    unit/{spec,core,service,wrapper}/ # mirror src; pure, in-memory ports, injected clock, no subprocess
    properties/                    # fast-check: merge, within-parent, determinism, compiled == fresh
    conformance/{engine.conformance.spec.ts,d4-trace.spec.ts}
    integration/                   # real service under tmp/policy/; optional-inputs matrix (PS-22)
    architecture/{layers.spec.ts,entry-files.spec.ts}   # 1.2 rules; entry files contain no logic (SV-03); src never imports the plugin (LP-02); client imports no apigen or MCP code (SC-07)
    contract/decider-port.spec.ts                       # imports the plugin's port and fails if createDecider drifts (LP-03)
    e2e/                           # *.e2e.test.ts, `e2e` lane
      surface-parity.e2e.test.ts   # same operations via library, CLI, MCP client, HTTP client: equal results (SV-04)
      cli.e2e.test.ts  mcp.e2e.test.ts  http.e2e.test.ts
      run-bin.e2e.test.ts          # alias-style `run bin:` with --adhd-attributes, real child command, no server (VR-02, SV-20)
      wrap-mcp-json.e2e.test.ts    # real .mcp.json, real host-side client, real stub server: no other process (WM-08)
      filesystem-server.e2e.test.ts # the real filesystem MCP server behind serve with a drafted policy (PS-26)
      import-starts-nothing.e2e.test.ts  # PS-23
      layer-plugin.e2e.test.ts     # real apigen CLI and MCP hosts with the plugin and createDecider (LPS-01, LPS-02)
    fixtures/{policies,attributes,expected}/
    helpers/{memory-ports,builders,mcp-client,http-client}.ts
```

## 8. Testing strategy

| Layer | Lane | What it proves | Behaviors |
|---|---|---|---|
| Schema | unit | Valid and invalid documents against both JSON Schemas; types match schema | PM, CL-04 |
| Compile | unit | Layer merge, defaults, attribute and runtime declarations, narrowing coverage, issues with paths | LY, CL-03 to CL-06 |
| Evaluate | unit | Every D4 trace decision; resolution order; `set`; errors become deny | PM, CL-07, CL-08, FC-01 |
| Properties | unit | Child never exceeds parent; compile deterministic; compiled == fresh compile | MG, NR-01, SI-03, PS-03, PS-16 |
| Engine conformance | unit | Engine semantics pinned; fails if the engine changes | QE-07, PS-18 |
| Memo | unit | Hit path, edited layer, concurrent loads in one process | CC-*, PS-17 |
| Optional inputs | integration | No attributes, no runtime provider, no server; absent attribute; `runtime-unavailable`; importing starts nothing | SC-05, SC-06, AT-09, AT-10, RT-09, PS-22 to PS-24 |
| Operations | unit/integration | Each operation through `IPolicyCtx` with in-memory ports | SV-06, SV-07 |
| Architecture | unit | Layer imports; entry files contain no logic; root export loads no apigen | BO-04, IN-12, IN-16, SV-03, SV-13 |
| Surface parity | e2e | Library, CLI, MCP and HTTP return equal results for the same inputs | SV-04 |
| `run bin:` | e2e | A real command run through `run bin:` with attributes from a flag, an env var and a file re-read per request; denied command never runs; `--adhd-*` flags stripped; no server | VR-02, VR-09, SV-20, PS-28 |
| `.mcp.json` wrapping | e2e | A stub MCP server wrapped by `serve` behaves identically when allowed, is denied/forced/asked per policy, and works with nothing else running; `mcp-json init` and `--undo` round-trip; the real filesystem server needs no hand mapping | SV-14, WM-01 to WM-11, PS-21, PS-26 |
| Entrypoints | e2e | Each bin started as a user would; MCP over stdio, HTTP on loopback; errors and exit codes | SV-10, IN-10 |

Rules: every behavioral test has a negative control (PS table); no sleeps (latches and the injected clock); prerequisites missing fail loudly; tests write under `tmp/policy/` and clean up; coverage is reported, not estimated. Clients are tested as a third party would use them, through the package's public entries.

## 9. Build order and gates

1. Approval for both packages (BO-02), add the `policy` domain, then scaffold the client with the `core` generator and the wrapper with the `entrypoint` generator (BO-03).
2. `spec` and `core` (unit, properties, conformance green); layer lint rule and architecture tests in place from the first commit.
3. `service`: `api.ts`, ports, environment wiring.
4. Entry files (cli, mcp, http) and the baked IR; parity and entrypoint e2e.
5. Wrapper verbs (`run`, `serve`, `mcp-json`): they depend on the apigen `remote` and `bin` sources (OD-32), which land first; static gate and `.mcp.json` wrapping e2e.
6. `createDecider`, then the apigen Layer plugin package (separate; BO-06 approval first; `architect-interfaces-layer.md`), whose proofs (LPS-01, LPS-02) run in this package's tests.
7. Docs, deployment notes and recipes. The sandbox, the auth layer and host integrations are separate consumers and follow.

Gates per stage: `npx nx affected -t lint,typecheck,typecheck-spec`, then the project's `test`, then `e2e`, and `verify-dist-load`, which must load the root and all four bins.

## 10. Integration: `@adhd/environment`, `@adhd/data-query-engine`, apigen

Three existing workspace packages carry the cross-cutting work; the policy package writes none of it again (AGENTS.md rules: reuse, two-use). Each integration has exactly one home in the layer map (1.2), so no other layer can grow a second one.

| Integration | Home layer | Used for | Never used by |
|---|---|---|---|
| `@adhd/data-query-engine` | `core/engine/` | Evaluating every `context`/`args` expression | service, entry, spec |
| `@adhd/environment` | `service/config/` | Locating layers and logs; operational settings; the attribute source of the wrapper | core (it receives values as arguments) |
| apigen (`apigen-core-client`, `-engine-naming`, `-plugin-cli-output`, `-plugin-mcp`, `-plugin-api-fastify`, `-plugin-ir-cache`, `-plugin-tracing`) | `entry/` | Projecting the operation set to CLI, MCP and HTTP | spec, core, service |

### 10.1 `@adhd/data-query-engine`: expression evaluation

- Only `core/engine/matches.ts`, `within.ts`, `validate.ts` import it (QE-06). All three use public exports only.
- Contract the policy package relies on, each pinned by a conformance test (QE-07): a flat object with several keys is a conjunction; dotted paths including list indexes (`command.0`) resolve; `_and`, `_or`, `_not`, `_eq`, `_in`, `_lte`, `_gte`, `_like`, `_regex`, `_contained_in` behave as the engine ships them (`_like` is a substring test with no `%`/`_` wildcards; `_contained_in` is scalar list membership); a missing field makes a comparison false rather than throwing (in a permission `context` this holds for negative operators too, with `_is_null` as the presence test, AT-10/AT-12).
- Row construction: `evaluate` builds one row per filter. For `context`, the row is `{ ...attributes, runtime }`. For `args`, the row is the call's `args`, extended with `child` (the completed child attributes) when the tool creates children.
- Placeholder substitution happens before the engine (QE-03): a string leaf `$attributes.<name>` is replaced by the effective attribute's value; an unknown name is a compile error (`undeclared-attribute`), never a runtime deny.
- Operators the engine lacks (`_within`): rewritten in `within.ts` into engine operators plus path normalization; if the owner contributes `_within` to the engine later, `within.ts` becomes a re-export and nothing else changes (QE-04, OD-12).
- `validateExpression` walks the expression and rejects operators the engine does not support, so a typo is caught by `compile`, not by a silent no-match (QE-05).
- Verification needed before build (IF-01): that one expression can be applied to one in-memory row synchronously. If the engine's `DataView` needs a table, `matches` wraps a one-row view.

### 10.2 `@adhd/environment`: global, project and runtime configuration

Only `service/config/` imports it. It resolves values and passes them down as plain arguments, so `core` stays testable without a cascade (4.5, 4.6).

```typescript
// entrypoint/policy/src/service/config/env-spec.ts
import type { EnvironmentSpec } from '@adhd/environment-base-spec';

export interface IPolicyConfig {
  readonly policy: { readonly files: string | undefined };        // explicit layer file override (flag/env)
  readonly ask:    { readonly timeoutMs: number };
  readonly logging:{ readonly level: string };
}

export const policyEnvironmentSpec: EnvironmentSpec<IPolicyConfig> = {
  envPrefixOverride: 'ADHD_POLICY',
  namespaces: ['production', 'test'],
  dirs:  { config: { kind: 'config' }, cache: { kind: 'cache' }, logs: { kind: 'logs' } },
  files: { global: { in: 'config', name: 'global.yaml' }, local: { in: 'config', name: 'local.yaml' } },
  config: {
    'policy.files':      { type: 'string',  env: 'ADHD_POLICY_FILES' },
    'ask.timeoutMs':     { type: 'integer', env: 'ADHD_POLICY_ASK_TIMEOUT_MS', default: 60000 },
    'logging.level':     { type: 'string',  env: 'ADHD_POLICY_LOG_LEVEL', default: 'info', enum: ['debug','info','warn','error','silent'] },
  },
};
```
The field names above follow the `backlog` precedent; exact `dirs` kinds supported (`config`, `logs`) are unverified (IF-03).

Mapping to the cascade (code defaults, system, global, project, environment variables):

| Level | Policy meaning |
|---|---|
| Code defaults | Built-in default policy (fail closed; PD-04) and the defaults in `config` above |
| System | Optional machine-wide settings; policy layer file only if present |
| Global (`global` scope) | `global` policy layer file and the log directory (user home); the apigen IR cache directory (10.3) |
| Project (`project` scope) | Project policy layer (walk-up `workspace-policy.yaml`, D1) and the `local` layer file |
| Runtime (environment variables) | Operational settings only, plus `ADHD_POLICY_ATTRIBUTES` read by the wrapper as launcher-supplied data (EV-05) |

Rules:
- Scope default is `project` when a project marker is found, else `global` (the generic cascade behavior). It is not forced to `global` as `backlog` does, because policy is per project by design.
- Layer files are data; settings are operational. Environment variables locate files and set timeouts and log levels. They cannot add, remove or widen a permission (EV-03). `compile` has no environment access at all.
- `ADHD_POLICY_ATTRIBUTES` (a JSON object or `@file`) is read only by the wrapper, as data the launcher supplies (EV-05). It is self-asserted when the governed process controls its own environment (SC-08). It is not in `policyEnvironmentSpec.config`, so `environment-cli` does not present it as a setting.
- Namespaces: `production` default; `test` for the package's own test lane so tests never touch the user's real cache or logs (also satisfies the tmp/cleanup rule).
- The log directory and violation log come from `env.dirs` (EV-04). No path is derived from `process.cwd()`.
- `policy doctor` prints the resolved settings with the source level of each value (the cascade already knows it), and `environment-cli` lists them with no extra work (EV-07).

### 10.3 apigen: CLI, MCP and HTTP are projections of the operation set

Principle (apigen Tenet 0 and 1): the functions are the source of truth; every transport is derived. The package hand-writes no argument parsing, validation, help text, exit codes, routes or MCP tool schemas (SV-03).

- One operation module (`service/api.ts`, section 5) is mounted by three tiny entry files: `cliPlugin.run` for the CLI, `mcpPlugin` for MCP, the fastify plugin for HTTP, the way `entrypoint/backlog` mounts one operation set on three transports.
- Names, namespace, casing and routes come from the naming authority (`@adhd/apigen-engine-naming`) and out-of-source options, not annotations.
- Exposure: every export is exposed by default. A deployer narrows the set with apigen include/exclude options (SV-11). Authentication, rate limits and tracing are apigen layers selected by configuration (SV-10).
- `dist/api.ir.json` is baked at build (`adhd-policy ir-artifact --out dist/api.ir.json`), so a run does no ts-morph extraction. `apigen-plugin-ir-cache` is the runtime fallback; its cache root comes from `env.dirs.cache` with `global` scope, never `process.cwd()`.
- `apigen-plugin-tracing` is mounted on all three so every operation is traced.
- Heavy dependencies (`ts-morph`, `typescript` via apigen-core-client) belong to the entry files only; importing the root starts no listener or process (SC-06). A consumer who imports `@adhd/policy` loads none of them; the architecture test loads the root in a clean process and inspects the module list (CL-12, IN-12, SV-13).
- `check` exists so scripts can gate on an exit code; apigen maps `permission_denied` to exit 3 and `invalid_argument` to 2. Whether `ask` also exits 3 is open (SV-08, IN-09).
- Operation inputs must be representable by apigen's schema extraction (`Record<string, unknown>`, the `AttributeValue` union); IF-12 tracks this.

### 10.4 Layer and test consequences

- The architecture tests gain rules: only `core/engine/**` imports the query engine; only `service/config/**` imports `@adhd/environment*`; only `entry/**` imports apigen packages or server libraries; entry files contain no logic (SV-03).
- Unit: operations are called as plain functions with an in-memory `IPolicyCtx`; no apigen involved.
- Integration: the built bins are driven as a user would (`policy compile`, `policy check`, exit codes; the MCP and HTTP servers with real clients), using the real apigen path, a real `Environment` in the `test` namespace and a temporary directory under `tmp/policy/`.
- E2E: surface parity: the same inputs through library, CLI, MCP and HTTP give equal results (SV-04).

## 11. Open items specific to this document

| ID | Item |
|---|---|
| IF-01 | Confirm `DataView` can serve `matches` synchronously per row, else add the adapter strategy in 4.3. |
| IF-02 | Package name and approval (BO-02, BO-05); no new domain is needed because entrypoints carry no domain. |
| IF-03 | Confirm the `dirs` kinds (`config`, `cache`, `logs`) and the `files` shape that `EnvironmentSpec` supports (10.2). |
| IF-05 | Decide `context` parameter naming in `evaluate` (4.1 note). |
| IF-06 | Conflicting `set` values: deny at runtime or compile error only. |
| IF-07 | Names of the MCP and HTTP server bins (the CLI bin is `adhd-policy`). |
| IF-08 | Accept the repo-rule deviation in 1.3, or choose a different split-out trigger than SV-17. |
| IF-14 | Approval and name of the apigen Layer plugin package (BO-06, OD-17). |
| IF-10 | `ask` outcome of `check`: interim `permission_denied`; target an apigen approval code (OD-16). |
| IF-11 | Whether `adhd-policy` can be apigen's CLI with the policy Layer preloaded and the `run` and `serve` source verbs, or a thin bin that execs `apigen` with fixed `--use` arguments. |
| IF-12 | Confirm apigen handles `Record<string, unknown>` and `AttributeValue` unions in operation inputs without a loss of schema detail. |
| IF-15 | Whether `IRuntimeProvider.observe` needs the `scope` key and the attributes, or only the tool (RT-08). |
| IF-16 | The argv fallback operation's `args` shape (`{ argv, cwd }`) and how `set` applies to it (SV-21). |
