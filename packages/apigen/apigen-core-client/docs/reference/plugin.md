# plugin

Plugin contracts — the v1 `OutputPlugin` interface for code generation and the v2 `Plugin` capability interface for the full plugin lifecycle (SPEC §7.1).

## v2 Plugin Interface

### `Plugin<Opts>`

The top-level v2 plugin shape. Every apigen plugin is an object satisfying this interface. All four capability slots are optional.

```ts
interface Plugin<Opts = Record<string, unknown>> {
  id: string;                        // unique identifier (e.g. '@adhd/apigen-http-fastify')
  description?: string;              // shown in `apigen plugins list`
  language?: PluginLanguage;         // source language consumed (default: 'ts')
  optionsSchema?: Record<string, unknown>;  // JSON Schema for plugin opts
  capabilities: {
    target?: TargetCapability<Opts>;   // project descriptor → files/server
    layer?: LayerCapability;           // wrap operations (onion)
    mount?: MountCapability;           // add synthetic operations
    envelope?: EnvelopeCapability;     // declare side-channel fields
  };
}
```

### `TargetCapability<Opts>`

Selected by `--type <name>`. Projects the descriptor to a transport/format and optionally hosts domain functions in-process.

```ts
interface TargetCapability<Opts = Record<string, unknown>> {
  name: string;   // e.g. 'mcp', 'http-fastify', 'cli'
  generate(descriptor: Descriptor, opts: Opts): File[] | Promise<File[]>;
  serve?(descriptor: Descriptor, harness: Harness, opts: Opts): Promise<Server>;
}
```

**v1 migration:** Wrap your existing `generate(PluginInput)` in `TargetCapability.generate(Descriptor)`, construct `PluginInput` from the `Descriptor`, and set `capabilities.target = { name, generate }`.

### `LayerCapability`

Loaded by `--use <plugin>`. Wraps all operations — owns the continuation.

```ts
interface LayerCapability {
  envelopeFields?: Record<string, JSONSchema>;  // extra fields merged into descriptor
  layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>;
}
```

- Call `next()` to invoke remaining layers and `dispatch`. Not calling `next()` short-circuits.
- Return `AsyncIterable<Chunk>` for streaming operations (SPEC §11).

### `MountCapability`

Loaded by `--use <plugin>`. Contributes synthetic operations (e.g. `/meta/openapi`, `/meta/health`).

```ts
interface MountCapability {
  operations(descriptor: Descriptor, opts?: Record<string, unknown>): MountedOperation[];
}
```

### `MountedOperation`

```ts
type MountedOperation = Operation & {
  transports?: Transport[];   // filter: expose only on these transports
  handler(call: Call): unknown | Promise<unknown> | AsyncIterable<Chunk>;
};
```

### `EnvelopeCapability`

Loaded by `--use <plugin>`. Declares transport-agnostic side-channel fields without wrapping operations in a Layer.

```ts
interface EnvelopeCapability {
  request?: Record<string, JSONSchema>;   // fields read from incoming metadata
  response?: Record<string, JSONSchema>;  // fields written to outgoing metadata
}
```

Canonical field identity is `(pluginId, field)` — surfaced as `x-<pluginId>-<field>` on HTTP/gRPC/MCP, `--<pluginId>-<field>` on CLI.

## Transport-Neutral Types

### `Call`

The inbound call descriptor passed to every layer and dispatch.

```ts
interface Call {
  operation: Operation;              // the operation being invoked
  data: Record<string, unknown>;     // bare domain params (envelope dissolved, ctx excluded)
  envelope: Record<string, unknown>; // transport-native side-channel fields
  ctx: Extensions;                   // typed request-extensions map (mw → mw → fn)
  transport: Transport;              // 'http' | 'grpc' | 'mcp' | 'cli'
  signal: AbortSignal;               // wired to transport-native cancellation
  raw?: unknown;                     // escape hatch for transport adapters
}
```

### `Next`

The continuation — call at most once per request.

```ts
type Next = () => Promise<Result> | AsyncIterable<Chunk>;
```

### `Result` / `Chunk`

```ts
type Result = unknown;
type Chunk = unknown;
```

### `Transport`

```ts
type Transport = 'http' | 'grpc' | 'mcp' | 'cli';
```

### `Extensions`

A type-keyed mutable map threaded through layers.

```ts
interface Extensions {
  get<T>(key: abstract new (...args: never[]) => T): T | undefined;
  set<T>(key: abstract new (...args: never[]) => T, value: T): void;
}
```

### `Descriptor`

The merged canonical descriptor passed to plugins at generate/serve time.

```ts
interface Descriptor {
  operations: Operation[];  // in insertion order
  host: string;             // primary language runtime tag
  namespace?: string;       // from --namespace or tsconfig folder
}
```

### `Harness` / `Server` / `File`

```ts
interface Harness {
  invoke(op: Operation, call: Omit<Call, 'operation' | 'ctx'>): Promise<Result> | AsyncIterable<Chunk>;
}

interface Server {
  close(): Promise<void>;
}

interface File {
  path: string;
  content: string;
}
```

## v1 Plugin Interface (backward-compatible)

### `OutputPlugin`

The legacy v1 contract — coexists with v2 `Plugin`.

```ts
interface OutputPlugin {
  id: string;
  description: string;
  language?: PluginLanguage;    // default: 'ts'
  optionsSchema?: Record<string, unknown>;
  generate(input: PluginInput): PluginOutput | Promise<PluginOutput>;
  run?(input: RunInput): Promise<void>;
}
```

### `PluginInput` / `PluginOutput` / `RunInput`

```ts
interface PluginInput {
  packages: Array<{
    id: string;
    schemas: ComposedSchemas;
    importPath: string;
    fns?: Record<string, (...args: unknown[]) => unknown>;
    createClient?: (envelope: Record<string, unknown>) => Promise<unknown>;
  }>;
  outputDir: string;
  options: Record<string, unknown>;
  logger?: Logger;  // pino instance (stderr/file, never stdout)
}

interface PluginOutput {
  files: Array<{ path: string; content: string }>;
  postCommands?: string[];
}

interface RunInput extends PluginInput {
  signal?: AbortSignal;
}
```

### `PluginLanguage`

```ts
type PluginLanguage = 'ts' | 'py' | 'rust' | 'go' | 'java';
```

## See Also

- [How-To: Building Plugins](../how-to/building-plugins.md)
- [Descriptor types](./descriptor.md) — `Operation`, `Segment`, `JSONSchema`
