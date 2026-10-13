// Source kinds for `adhd-policy run|serve` (T08 / OD-32 / D-07 / D-08).
//
// A source (`bin:<command>`, later `remote:` / file) is resolved to the hand-built
// `{pkg, operations}` pair that `apigen-plugin-mcp` / `apigen-plugin-cli-output`'s
// `run()` accept (same shape as `entrypoint/backlog/src/server.ts`
// `buildBacklogApigenPackage`). See docs/plan/policy-core/T08-discovery.md.

import type { Operation, composeSchemas } from '@adhd/apigen-core-client';

/** A parsed source argument. */
export type SourceSpec =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'bin'; readonly command: string };

/** `run` resolves lazily (nothing starts until an operation is invoked); `serve` is an explicit start. */
export type SourceIntent = 'run' | 'serve';

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
  /** Kills any process this source started. Idempotent. */
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
