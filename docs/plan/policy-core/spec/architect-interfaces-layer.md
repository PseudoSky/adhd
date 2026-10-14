# Interface specification: the apigen policy Layer plugin

Status: draft for owner review. Companion to `architect-spec-layer.md`. Nothing here creates a package; approval is BO-06.

## 1. Package

| Item | Value |
|---|---|
| Path / name | `packages/apigen/apigen-plugin-policy`, `@adhd/apigen-plugin-policy` (name pending, LP-O1) |
| Tags | `layer:logic`, `platform:node` (as `apigen-plugin-health`) |
| Scaffold | `npx nx g @adhd/workspace-codegen-nx:plugin --name policy --group apigen --nxLayer logic --platform node --dry-run`, then without `--dry-run` once approved |
| Runtime dependencies | `@adhd/apigen-engine-runtime` (Layer and Call types), `@adhd/apigen-base-errors` (`ApiError`). Nothing else. |
| Forbidden imports | `@adhd/policy` and anything that depends on it (LP-02) |

## 2. Port (defined here, satisfied structurally by `@adhd/policy`)

```typescript
// src/ports.ts
export interface IPolicyDecideRequest {
  /** The apigen operation id of the call. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly transport: 'http' | 'grpc' | 'mcp' | 'cli';
  /** Read from the call envelope, where an earlier layer (an auth layer) wrote them (LP-09). Absent means none (AT-09). */
  readonly attributes?: Readonly<Record<string, string | number | readonly string[]>>;
}

export type IPolicyDecision =
  | { readonly decision: 'allow'; readonly set?: Readonly<Record<string, unknown>> }
  | { readonly decision: 'ask'; readonly reason?: string }
  | { readonly decision: 'deny'; readonly reason?: string };

export interface IPolicyDecider {
  decide(request: IPolicyDecideRequest, signal?: AbortSignal): Promise<IPolicyDecision>;
}

export interface IPolicyAskHandler {
  ask(request: IPolicyDecideRequest, reason?: string): Promise<'allow-once' | 'deny'>;
}
```

## 3. Plugin

```typescript
// src/plugin.ts  (default export, loaded by --use)
export interface IPolicyLayerOptions {
  /** An object, or a module specifier / path exporting `createDecider(options)`. */
  readonly decider: IPolicyDecider | string;
  /** Options handed to `createDecider` when `decider` is a module reference. */
  readonly deciderOptions?: Readonly<Record<string, unknown>>;
  readonly ask?: IPolicyAskHandler;
  /** Optional deadline for one decision. Expiry denies (LP-11). */
  readonly timeoutMs?: number;
}

export function createPolicyLayerPlugin(options: IPolicyLayerOptions): UsePlugin;
// UsePlugin is the structural shape in apigen-engine-runtime/src/lib/package-invoker.ts:
// { id: 'policy', capabilities: { layer: { layer(call, next), envelopeFields? } } }
```

Behavior of `layer(call, next)`: build `IPolicyDecideRequest` from `call.operation.id`, `call.domainArgs`, `call.envelope`, `call.transport`; await `decide`; map `allow` to `next()` with `set` merged into `call.domainArgs`, `deny` to `throw ApiError('permission_denied')`, `ask` to the handler or `deny`; any failure or malformed result is `deny`.

## 4. What `@adhd/policy` provides (no import of this package)

```typescript
// entrypoint/policy/src/service/decider.ts, exported from the package root
export function createDecider(options?: { readonly scope?: string }): {
  decide(request: {
    tool: string; args: Readonly<Record<string, unknown>>; envelope: Readonly<Record<string, unknown>>;
    transport: 'http' | 'grpc' | 'mcp' | 'cli';
    attributes?: Readonly<Record<string, string | number | readonly string[]>>;
  }, signal?: AbortSignal): Promise<
    | { decision: 'allow'; set?: Readonly<Record<string, unknown>> }
    | { decision: 'ask'; reason?: string }
    | { decision: 'deny'; reason?: string }
  >;
};
```
It is a thin mapping over the `evaluate` operation: the request's `attributes` are passed through, and `scope` is handed to the service context's `IRuntimeProvider` when one is configured (RT-08). It reads no credential and verifies nothing about the attributes (SC-08). The shape is repeated here on purpose: the contract test in `entrypoint/policy/test/contract/decider-port.spec.ts` imports both and fails on drift (LP-03).

## 5. Usage

```
adhd-apigen run --use <auth layer> --use @adhd/apigen-plugin-policy --type mcp -- <sources>
# the auth layer (any earlier layer) writes attributes to the envelope; the policy layer comes after it (LP-14)
# options (decider specifier, ask handler, timeout) come from out-of-source configuration
```

## 6. File structure

```
packages/apigen/apigen-plugin-policy/
  package.json project.json tsconfig*.json eslint.config.mjs vite.config.ts README.md AGENTS.md CHANGELOG.md
  src/
    index.ts        # default export plugin, createPolicyLayerPlugin, port types
    plugin.ts       # the layer
    ports.ts        # IPolicyDecider and friends
    load-decider.ts # specifier/path -> decider (the only dynamic import)
  test/
    unit/           # allow/set/deny/ask/failure paths with a fake decider; no apigen host
    architecture/imports.spec.ts   # no @adhd/policy, only the two runtime dependencies (LP-02)
```
The integration and e2e proofs (LPS-01, LPS-02) live in `entrypoint/policy/test/` because they need the real decider; the plugin's own tests never import `@adhd/policy`.

## 7. Open items

| ID | Item |
|---|---|
| LI-01 | Confirm the exact `UsePlugin` and envelope-field shape against `package-invoker.ts` and the cli-output and mcp hosts before implementation (LP-O2). |
