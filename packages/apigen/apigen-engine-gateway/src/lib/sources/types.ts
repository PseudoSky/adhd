// Source kinds for `adhd-policy run|serve` (T08 / OD-32 / D-07 / D-08).
//
// A source (`bin:<command>`, later `remote:` / file) is resolved to the hand-built
// `{pkg, operations}` pair that `apigen-plugin-mcp` / `apigen-plugin-cli-output`'s
// `run()` accept (same shape as `entrypoint/backlog/src/server.ts`
// `buildBacklogApigenPackage`). See docs/plan/policy-core/T08-discovery.md.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { isApiError } from '@adhd/apigen-base-errors';
import type { ApiError } from '@adhd/apigen-base-errors';
import type { Operation, composeSchemas } from '@adhd/apigen-core-client';
import { makeUnavailableError } from '../gateway';

/** A parsed source argument. */
export type SourceSpec =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'bin'; readonly command: string };

/**
 * `run` resolves lazily (nothing starts until an operation is invoked); `serve` is an explicit
 * start. Only used to fill a resolution's unset translator: `run` -> `argv`, `serve` -> `mcp`.
 */
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

// Failures of source parsing, resolution or startup are core `ApiError`s (TAXONOMY §7, B9):
// an invalid or unsupported source is `ApiError('invalid_argument')`; a process that cannot
// be started or an upstream that fails its handshake is `makeUnavailableError(<binding>,
// '(start)', reason)` from the gateway error model.

/**
 * Normalise a startup failure (spawn, handshake, `tools/list`) to the gateway `unavailable`
 * error for `binding`. An `ApiError` the launcher already raised (a confining launcher's own
 * refusal, for example) passes through unchanged. Internal to `sources/`.
 */
export function startError(binding: string, cause: unknown, context?: string): ApiError {
  if (isApiError(cause)) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return makeUnavailableError(binding, '(start)', context ? `${context}: ${reason}` : reason);
}
