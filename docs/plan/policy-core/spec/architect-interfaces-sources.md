# Interface specification: apigen sources (`remote`, `bin`)

Status: draft for owner review. Companion to `architect-spec-sources.md` (behaviors: SRC, GW, AK, WM) and `architect-interfaces.md`. These interfaces belong to apigen (OD-32), not to the policy packages: policy only consumes the IR they produce and the `draft` operation. Type names for the IR must be confirmed against `@adhd/apigen-core-client` before build (IF-S1); the shapes below show what the source work needs, not names that exist today.

## 1. Source specification

```typescript
// BEFORE: apigen sources are files (--source ./api.ts)
// AFTER: two more kinds
export type SourceSpec =
  | { kind: 'file'; path: string }                                   // existing
  | { kind: 'remote'; url: string; name: string; protocol?: RemoteProtocol }
  | { kind: 'bin'; command: string[]; name: string; extract?: BinExtractMode };

export type RemoteProtocol = 'mcp' | 'openapi' | 'graphql' | 'grpc';   // v1: mcp, openapi (SRC-02, OD-31)
export type BinExtractMode = 'static' | 'help';                        // 'help' executes the binary (SRC-06)
```

CLI forms: `remote:<url>` and `bin:<command and args>` accepted wherever `--source` is.

## 2. Extractor and invoker

```typescript
export interface ISourceExtractor {
  /** Cheap check: can this extractor handle the spec? (protocol probe or binary sniff) */
  accepts(spec: SourceSpec): Promise<boolean>;
  /** Produces IR operations; every argument carries kind and provenance (SRC-08). */
  extract(spec: SourceSpec): Promise<IExtractResult>;
}

export interface IExtractResult {
  operations: IOperation[];          // the existing apigen IR operation type (IF-S1)
  version: string;                   // etag, document hash or tool-list hash (SRC-10)
  notes: string[];                   // unrepresented capabilities, e.g. resources, prompts (SRC-13)
}

export type ArgKind = 'path' | 'url' | 'host' | 'command' | 'id' | 'pattern' | 'flag' | 'text' | 'unknown';

export interface IArgumentMeta {
  kind: ArgKind;
  provenance: 'declared' | 'inferred';  // inferred = name or description heuristic (SRC-08)
}

/** Operation-level hints copied from the upstream, unverified (SRC-14). */
export interface IOperationHints {
  readOnly?: boolean;                // MCP readOnlyHint
  destructive?: boolean;             // MCP destructiveHint
}

export interface IOperationInvoker {
  invoke(op: IOperation, args: unknown, ctx: IInvokeContext): Promise<unknown>;   // SRC-04, SRC-07
}

export interface IInvokeContext {
  attributes: Attributes;            // for the credential seam only
  signal?: AbortSignal;
}

/** The credential seam (SRC-12). Filled by an auth layer or broker; apigen stores none. */
export interface ICredentialProvider {
  credentialFor(op: IOperation, attributes: Attributes): Promise<IUpstreamCredential | undefined>;
}
export type IUpstreamCredential = { headers?: Record<string, string>; env?: Record<string, string> };
```

## 3. Process launcher (implemented by a sandbox)

```typescript
export interface IProcessSpec { name: string; command: string[]; env?: Record<string, string>; cwd?: string }

export interface IProcessLauncher {
  /** Starts the upstream process. A confining launcher fails closed: no sandbox, no process (FC-02). */
  launch(spec: IProcessSpec, attributes: Attributes): Promise<IProcessHandle>;
}
export interface IProcessHandle { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; exit: Promise<number>; kill(): void }
```

The default launcher is a plain spawn. `@adhd/policy` does not implement or import it.

## 4. Policy side: the `draft` operation

```typescript
// client package, service/api.ts: a new operation (SRC-11)
export function draft(input: { operations: IDraftOperation[]; options?: IDraftOptions }): Promise<IDraftPolicy>;

/** A plain data view of an IR operation, so the client imports no apigen code. */
export interface IDraftOperation { name: string; args: Array<{ name: string; type: string; kind?: string; provenance?: 'declared' | 'inferred' }>; hints?: { readOnly?: boolean; destructive?: boolean } }
export interface IDraftOptions { source: string; secretPatterns?: string[] }
export interface IDraftPolicy { document: IPolicyDocument; inferred: Array<{ path: string; reason: string }> }
```

The wrapper maps the IR to `IDraftOperation[]`; the client never sees apigen types (SC-02). The result lists every inferred value so the author confirms it.

## 5. Open items (IF-S)

| ID | Item |
|---|---|
| IF-S1 | Confirm the IR operation type and where `kind` and `provenance` attach in `@adhd/apigen-core-client`. |
| IF-S2 | Whether source probing runs at CLI start or lazily on first `tools/list`. |
| IF-S3 | Whether the apigen MCP host can advertise operations that appear after startup (`list_changed`) (SRC-10). |
