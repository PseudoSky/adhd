import type { Logger } from 'pino';
import type { Operation } from './descriptor';

// Output of the extraction pipeline (v2 `extract()`'s Operation[], grouped by
// namespace and adapted — see orchestrator.ts's buildDescriptor Step 5) —
// domain schemas only, no middleware envelope.
export interface GeneratedSchemas {
  metadata: { namespace: string; phase: string };
  schemas: Record<
    string,
    {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
      // True when the source fn's first param is named `ctx` (filtered from
      // `input.properties` by [inv:ctx-name-only], but still injected at dispatch).
      hasCtx?: boolean;
      // BUG-APIGEN-025: the operation's `safe` flag (SPEC §4/§5), threaded
      // through from `Operation.safe` at the call site (orchestrator.ts's
      // buildDescriptor Step 5) so `composeSchemas()` has it available to
      // stamp onto `x-apigen-safe` — previously computed but never carried
      // this far, so the HTTP transports' `x-apigen-safe` read was always
      // `undefined`. Absent (`undefined`) is treated as `false`.
      safe?: boolean;
    }
  >;
}

// Output of composeSchemas() — domain + middleware envelope merged
// data: {} wrapper is ALWAYS present, even for zero-param functions
export type ComposedSchemas = Record<
  string,
  {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    // Carried through from GeneratedSchemas — see above. dispatch() injects ctx
    // as the first arg whenever this is true, independent of session middleware.
    hasCtx?: boolean;
    // FEAT-APIGEN-022 / BUG-APIGEN-025: `op.safe` OR "properly typed
    // primitives only" param shape (see get-safety.ts's
    // `isPrimitiveOnlyInputSchema`), stamped by `composeSchemas()`. Read by
    // the shared `httpVerb()` in `@adhd/apigen-engine-naming` (SPEC §5) — every
    // HTTP-emitting plugin derives its verb from THIS field, never by
    // re-deriving safety itself.
    'x-apigen-safe'?: boolean;
    // DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001: §9.1 envelope field →
    // owning pluginId, stamped by `composeSchemas()` from each contributing
    // `--use` plugin's own `id` (`pluginsToEnvelopeMiddlewares()`). Read by
    // `apigen-engine-runtime`'s `op-plan.ts` (`computeEnvelopeFields`) to
    // resolve the `x-<pluginId>-<field>` / `--<pluginId>-<field>` /
    // `APIGEN_<PLUGINID>_<FIELD>` transport bindings. Absent when no `--use`
    // plugin contributed an envelope field for this op.
    'x-apigen-envelope'?: Record<string, string>;
  }
>;

// v1 legacy selector — retired as a filtering mechanism (BUG-APIGEN-CORE-005,
// v1 retirement): v2's `extract()` walks the FULL export-shape matrix (named,
// default, named-object, CJS) unconditionally in one pass, so there is no
// longer a "select exactly one shape" mode. Kept only as an inert CLI
// `--export` passthrough type so existing invocations don't error — see
// SourceEntry.exportMode's doc comment in orchestrator.ts.
export type ExportMode =
  | { type: 'named' }
  | { type: 'default' }
  | { type: 'named-object'; name: string };

// Plugin system — language-agnostic: files[] can contain any language
export interface PluginInput {
  packages: Array<{
    id: string;
    schemas: ComposedSchemas;
    importPath: string;
    fns?: Record<string, (...args: unknown[]) => unknown>;
    createClient?: (envelope: Record<string, unknown>) => Promise<unknown>;
  }>;
  outputDir: string;
  options: Record<string, unknown>;
  /**
   * Shared structured logger (pino). Built once by the CLI and threaded through
   * the pipeline + plugins. Always targets stderr or a file — never stdout —
   * so the MCP stdio JSON-RPC channel stays clean. Plugins should fall back to
   * a default stderr logger when this is absent.
   */
  logger?: Logger;
  /**
   * DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001: the full merged
   * `Operation[]` descriptor (the same set `buildDescriptor()` produces),
   * threaded through so `generate()` can call the real `project(op)` for
   * every operation instead of falling back to a best-effort synthesized
   * `Operation` (exact only for the single-source-file case; wrong for
   * multi-file namespaces / npm-specifier importPath / default-object
   * exports). Lifted from `RunInput` (BUG-APIGEN-024) onto the base
   * `PluginInput` so both `generate()` and `run()` get real ops from the
   * same field. Optional: absent for non-TS-extraction paths (e.g.
   * py-flask) where nothing was extracted to describe.
   */
  operations?: Operation[];
}

export interface PluginOutput {
  files: Array<{ path: string; content: string }>;
  postCommands?: string[];
}

export interface RunInput extends PluginInput {
  signal?: AbortSignal;
}

/** Source-language tags understood by apigen's routing layer. */
export type PluginLanguage = 'ts' | 'py' | 'rust' | 'go' | 'java';

export interface OutputPlugin {
  id: string;
  description: string;
  /**
   * The source language this plugin consumes.
   *
   * Used by the `serve` command to route each source file to the plugin(s)
   * whose `language` matches its extension (`.ts`/`.tsx`/`.mts`/`.cts` → `'ts'`,
   * `.py` → `'py'`, etc.).
   *
   * Defaults to `'ts'` when omitted for backward-compatibility with plugins
   * authored before this field was introduced.  All first-party plugins
   * explicitly declare `language: 'ts'`.
   */
  language?: PluginLanguage;
  optionsSchema?: Record<string, unknown>;
  generate(input: PluginInput): PluginOutput | Promise<PluginOutput>;
  run?(input: RunInput): Promise<void>;
}
