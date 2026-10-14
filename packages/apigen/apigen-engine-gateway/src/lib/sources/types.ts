// Source kinds for `adhd-policy run|serve` (T08 / OD-32 / D-07 / D-08).
//
// A source (`bin:<command>`, later `remote:` / file) is resolved to the hand-built
// `{pkg, operations}` pair that `apigen-plugin-mcp` / `apigen-plugin-cli-output`'s
// `run()` accept (same shape as `entrypoint/backlog/src/server.ts`
// `buildBacklogApigenPackage`). See docs/plan/policy-core/T08-discovery.md.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Operation, composeSchemas } from '@adhd/apigen-core-client';

/** A parsed source argument. */
export type SourceSpec =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'bin'; readonly command: string };

/** `run` resolves lazily (nothing starts until an operation is invoked); `serve` is an explicit start. */
export type SourceIntent = 'run' | 'serve';

/** A tool the resolver refused to expose, with the reason. One bad tool never disables a source. */
export interface ISkippedTool {
  readonly tool: string;
  readonly reason: string;
}

/**
 * The live upstream of an MCP source: the full upstream `Tool` objects and a direct
 * `tools/call` path. The passthrough server uses this instead of the positional `fns`
 * table, so arguments and results reach the upstream and the host verbatim.
 */
export interface IMcpUpstream {
  /** Every exposed upstream tool (name, title, description, inputSchema, outputSchema, annotations), by upstream name. */
  readonly tools: ReadonlyMap<string, Tool>;
  /**
   * `tools/call` on the upstream with `args` exactly as given (undeclared properties
   * included) and the upstream's result returned verbatim. An error the upstream itself
   * returned rejects with the SDK `McpError` carrying the upstream's code.
   */
  callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  /** Registers `cb` for when the upstream connection closes (including the process exiting on its own). Fires at most once per registration. */
  onClose(cb: () => void): void;
}

/** A source resolved to the pair an apigen host consumes. */
export interface IResolvedSource {
  /** `'bin:touch'` | `'bin:mcp-server-filesystem'`. */
  readonly sourceId: string;
  readonly operations: Operation[];
  readonly pkg: {
    id: string;
    version: string;
    schemas: ReturnType<typeof composeSchemas>;
    importPath: string;
    /** Keyed by fn name (the last path segment's `raw`); called POSITIONALLY by apigen's dispatch. */
    fns: Record<string, (...a: unknown[]) => unknown>;
    createClient: () => Promise<unknown>;
  };
  /** Tools of an MCP source that were not exposed (non-object schema, duplicate or reserved name). */
  readonly skipped?: readonly ISkippedTool[];
  /** Present for an MCP (`serve`) source: the live upstream. */
  readonly mcp?: IMcpUpstream;
  /** Kills any process this source started (the whole process group). Idempotent. */
  dispose(): Promise<void>;
}

/** Typed failure of source parsing, resolution or startup. */
export class SourceError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'handshake-failed'
      | 'spawn-failed'
      | 'invalid-spec',
    message: string
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
