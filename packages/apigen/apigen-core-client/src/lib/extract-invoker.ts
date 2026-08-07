// extract-invoker.ts — the extract-stage onion contract (FEAT-002).
//
// The dispatch stage already has an onion: `--use` Layer plugins wrapping the
// central `dispatch()` call (`@adhd/apigen-engine-runtime`'s `createInvoker`,
// composed by `package-invoker.ts`'s `createPackageInvoker`). This module
// brings the SAME composition algebra to the EXTRACT stage — the pipeline step
// that turns a source artifact into canonical `Operation[]` descriptors — so a
// plugin can sit between a host and the real extractor and, e.g., answer from a
// persistent cache instead of re-running extraction (that exact plugin is
// `@adhd/apigen-plugin-ir-cache`).
//
// Two deliberate design choices, both load-bearing (see the FEAT-002 design
// proposal, docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md §1.2/§3):
//
//  1. `ExtractCall` is HOST-NEUTRAL by construction: `source`/`host`/`namespace`
//     + opaque `extractorOptions` — deliberately NOT `{sourceFile, tsconfig}`,
//     which are ts-morph's option names, not a neutral contract. SPEC §12
//     models extraction as a per-language subprocess (`apigen-<lang>-extractor`
//     → JSON over stdin/stdout); a future subprocess-based extractor must be
//     able to sit under the identical onion without redesigning it. A cache
//     layer above `runExtractor` is correct regardless of whether that terminal
//     step is today's in-process ts-morph call or tomorrow's spawned process —
//     a cache HIT never reaches `runExtractor` at all.
//
//  2. The composition primitive (`composeOnion`) is the same right-fold algebra
//     as `@adhd/apigen-engine-runtime`'s `createInvoker` (`invoke.ts:202-205`):
//     outermost-first, with the documented short-circuit rule (a middleware
//     returning without calling `next` skips every downstream middleware and the
//     terminal service). It is deliberately generic here rather than reusing the
//     dispatch-shaped invoker, whose `Call`/`InvokeOptions` are hardwired to
//     dispatch semantics (envelope/domainArgs/schemas) that extraction doesn't
//     have. No new Plugin capability is introduced — which stage a plugin's
//     `layer` runs in is decided solely by which array the host composes it into.

import type { Operation } from './descriptor';
// `Plugin` is imported type-only from './plugin', which itself imports
// `ExtractMiddleware` (below) type-only from this file — a same-package,
// type-level-only sibling cycle. `import type` on both sides means neither
// import survives to a runtime `require`/`import` (erased by the TS
// compiler), so there is no actual module-load cycle for the bundler to
// choke on — see design doc R2-2's note on this exact tradeoff.
import type { Plugin } from './plugin';

/**
 * One source unit to extract. Deliberately host-neutral — describes WHAT is
 * being extracted, not HOW (no ts-morph/ts-json-schema-generator names leak
 * in; a future per-language subprocess extractor speaks the same shape).
 */
export interface ExtractCall {
  /**
   * Absolute path to the source artifact for this language's extractor (a
   * `.d.ts`/`.ts` file today; a directory/module root for a future
   * subprocess-based extractor — the contract doesn't care which).
   */
  source: string;
  /** Declared owning language runtime tag, e.g. 'ts' | 'py' | 'rust' (SPEC §4 host). */
  host: string;
  /** Namespace segment (SPEC §4). Casing-neutral. */
  namespace?: string;
  /**
   * Free-form, extractor-specific options (e.g. a tsconfig path for TS today;
   * a venv path for Python tomorrow). Opaque to the onion — read only by the
   * terminal extractor step (and by cache layers that need identity signals).
   */
  extractorOptions?: Record<string, unknown>;
  /**
   * Opt-in caller-supplied identity tag for cache-key purposes (e.g. a
   * monorepo's own content-addressed build hash). Absence is fine — a cache
   * layer must compute its own key when absent, never trust an unverified
   * hint from an untrusted caller.
   */
  versionHint?: string;
}

/**
 * Extraction's RESULT is already the host-neutral descriptor shape SPEC §4
 * defines — reuse it verbatim, do not invent a parallel result type.
 */
export type ExtractResult = Operation[];

/** A stage-agnostic middleware step: receives the call, owns the continuation. */
export type ExtractMiddleware = (
  call: ExtractCall,
  next: () => Promise<ExtractResult>
) => Promise<ExtractResult>;

/**
 * Generic right-fold onion composition around an arbitrary innermost service.
 * Identical composition algebra to the dispatch invoker's `reduceRight`
 * (`apigen-engine-runtime`'s `invoke.ts`): `middlewares` are composed
 * outermost-first (index 0 runs first); a middleware that returns without
 * calling `next` short-circuits all downstream middlewares and the core.
 */
export function composeOnion<TCall, TResult>(
  middlewares: readonly (
    (call: TCall, next: () => Promise<TResult>) => Promise<TResult>
  )[],
  core: (call: TCall) => Promise<TResult>
): (call: TCall) => Promise<TResult> {
  return async (call: TCall) => {
    // Right-fold the chain outermost-first: start with the terminal step and
    // wrap inward, so `middlewares[0]` runs first and its zero-arg `next`
    // continues to `middlewares[1]`, etc. (identical algebra to a reduceRight;
    // written as a loop because TS 6's unified-signature checking can't infer
    // the generic reduceRight accumulator here). Each `next` is captured per
    // iteration, so the short-circuit rule holds: a middleware returning
    // without calling `next` skips every downstream middleware and the core.
    let inner: () => Promise<TResult> = () => core(call);
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i];
      const next = inner;
      inner = () => mw(call, next);
    }
    return inner();
  };
}

/**
 * Compose an extract-stage invoker: `middlewares` (e.g. a cache layer)
 * wrapping the terminal `runExtractor` step. Mirrors the dispatch stage's
 * `createPackageInvoker` for the extract stage — the terminal step is "run
 * the real extractor for `call.host`" instead of "run dispatch".
 *
 * A cache layer sits ABOVE `runExtractor`, so a cache HIT never invokes it —
 * which is what makes this correct whether `runExtractor` is an in-process
 * function today or a spawned subprocess tomorrow.
 */
export function createExtractInvoker(
  middlewares: readonly ExtractMiddleware[],
  runExtractor: (call: ExtractCall) => Promise<ExtractResult>
): (call: ExtractCall) => Promise<ExtractResult> {
  return composeOnion(middlewares, runExtractor);
}

/**
 * Mirrors `createPackageInvoker`'s (`apigen-engine-runtime`'s
 * `package-invoker.ts:124`) role for the extract stage (design doc Revision 2,
 * R2.6 item 2 / implementation spec R2-2): pulls every loaded plugin's
 * `extractLayer` capability — in declaration order, outermost-first, the
 * identical composition rule `--use` layer ordering already follows on the
 * dispatch side — and wraps `runExtractor` with them via {@link createExtractInvoker}.
 *
 * A plugin with no `extractLayer` capability (the common case today — nothing
 * ships one yet) is filtered out silently; passing an empty `plugins` array
 * (or a list where none declare `extractLayer`) degrades to `runExtractor`
 * itself, unwrapped — a pure pass-through with zero behavioural change from
 * calling `runExtractor` directly (R2-3's "byte-identical on MISS" guarantee).
 *
 * @param plugins      - The loaded `--use` plugin objects (or an explicit host-
 *                       constructed list, e.g. backlog's `extractStagePlugins()`).
 * @param runExtractor - The terminal extraction step (today: an in-process
 *                       ts-morph `extract()` call; SPEC §12: potentially a
 *                       spawned per-language subprocess later).
 * @param opts         - This invocation's flat `--opt key=value` bag (the
 *                       SAME bag already passed to `TargetCapability.generate`
 *                       — apigen-cli has one flat bag per invocation, not a
 *                       per-plugin-id namespaced one). Passed to each
 *                       plugin's `extractLayer.createLayer(opts)` when
 *                       present (`plugin.ts`'s `ExtractLayerCapability` doc);
 *                       a plugin with only a static `.layer` ignores it.
 *                       Defaults to `{}` — every existing call site (and
 *                       every plugin with no opts-dependent behaviour)
 *                       behaves identically whether this is passed or not.
 */
export function createExtractInvokerFromPlugins(
  plugins: readonly Plugin[],
  runExtractor: (call: ExtractCall) => Promise<ExtractResult>,
  opts: Record<string, unknown> = {}
): (call: ExtractCall) => Promise<ExtractResult> {
  const middlewares = plugins
    .map((p) => p.capabilities.extractLayer)
    .filter((cap): cap is NonNullable<Plugin['capabilities']['extractLayer']> => Boolean(cap))
    .map((cap) => (cap.createLayer ? cap.createLayer(opts) : cap.layer))
    .filter((mw): mw is ExtractMiddleware => Boolean(mw));
  return createExtractInvoker(middlewares, runExtractor);
}
