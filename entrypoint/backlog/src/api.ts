/**
 * api.ts — THE apigen extraction surface (SPEC.md §6.7).
 *
 * **The exported surface of this file IS the mounted surface.** `server.ts`'s
 * `extractClientOperations()` extracts the built `api.d.ts` — the whole file,
 * with no allow-list — so every exported function here becomes a command on
 * the CLI, a tool in MCP `tools/list`, a Fastify route, and a path in the
 * OpenAPI document. Adding an exported function here widens the tool surface
 * an agent must hold in its head; export from the implementation module and
 * re-export via `./index.ts` (library-only) instead.
 *
 * Rules, enforced by apigen's extraction:
 *  - plain, JSDoc'd async functions ONLY, no business logic inline;
 *  - `ctx: BacklogCtx` is the sole non-serializable parameter, excluded from
 *    the generated JSON Schema by the `ctx-name-only` invariant (the FIRST
 *    parameter named exactly `ctx`);
 *  - every other parameter/return type is plain and JSON-serializable.
 *
 * ## Why this file exists at all, given the verbs are already implemented
 *
 * The implementation layer (`./query/*`, `./write/*`) is written against
 * STORE HANDLES, not against a transport ctx, and deliberately so: the write
 * verbs take `IWriteStoreHandle` (`{adapter, typePolicy}`), `queryIssues`
 * takes `IQueryStoreHandle` (`{graph, search?}`), and `getIssue`/`lookup`
 * take a bare `GraphBackend`. Three different shapes, none of them named
 * `ctx`, none of them serializable. That is the right seam for the ETL and
 * for tests (which open a store directly and never build an `Environment`),
 * but apigen cannot mount it.
 *
 * So this module is the ONE adapter between the two: it owns `BacklogCtx`,
 * derives each handle shape from it, and presents the nine issue verbs plus
 * `lookup` in the single shape every transport projects from. It contains no
 * logic of its own beyond that derivation and the error mapping below.
 *
 * ## Errors
 *
 * The implementation layer THROWS named `BacklogWriteError` subclasses
 * carrying `E_*` codes (`write/errors.ts`) rather than returning a result
 * union — that is what SPEC §6.3 specifies ("A missing/blank `by` on a
 * mutating verb throws `InvalidArgumentError('by', ...)` before any write
 * runs"). Transports, however, need the `{ok, data?, error?}` outcome
 * envelope: `exitCodeForEnvelope` (model.ts) is what maps a failure to a
 * process exit code for the CLI, and apigen's own dispatch only sets
 * `process.exitCode` on a thrown `ApiError`, which these are not. So every
 * verb here catches and maps — `toEnvelopeError` below is the whole of that
 * translation, and it is the reason a caller error never escapes as a stack
 * trace on any of the four mounts.
 */
import type { Environment } from '@adhd/environment';
import type { BacklogConfig } from './env.js';
import type { GraphBacklogStore } from './store/graph-backlog-store.js';
import type { IWriteStoreHandle } from './write/tx.js';
import type { IQueryStoreHandle } from './query/query.js';
import {
  queryIssuesWithMeta,
  queryNeedsSemanticBackend,
} from './query/query.js';
import type {
  IOutcomeEnvelope,
  IOutcomeFailure,
  BacklogErrorCode,
} from './envelope.js';
import {
  errorEnvelope,
  okEnvelope,
  RagNotConfiguredError,
} from './envelope.js';
import {
  BacklogWriteError,
  CatalogNotFoundError,
  CitationRequiredError,
  CitationUnverifiableError,
  ClaimHeldError,
  InvalidArgumentError,
  IssueNotFoundError,
  IssueTerminalError,
  NoteRequiredError,
  SingleValuedRelationConflictError,
  StaleSupersedeError,
  WriteContentionError,
} from './write/errors.js';
import {
  bootstrapSemanticStoreMembers,
  peekSemanticStoreMembers,
  resetSemanticStoreMembers,
} from './write/bootstrap.js';
import type { SemanticStoreMembers } from './write/bootstrap.js';
import type { EmbeddingLiveConfig } from './write/embedding-config.js';
import { assertRecognizedStoreVocabulary } from './store/vocabulary-guard.js';

import { getIssue } from './query/get.js';
import {
  getRegistryDetail,
  lookup as lookupRegistry,
} from './query/views/registry.js';
import {
  priorityMatrix as priorityMatrixView,
  partOfRollup as partOfRollupView,
  openCurve as openCurveView,
} from './query/views/stats.js';
import type {
  IPriorityMatrixInput,
  IPriorityMatrixResult,
  IPartOfRollupInput,
  IPartOfRollupResult,
  IOpenCurveInput,
  IOpenCurveResult,
} from './query/views/stats.js';
import {
  createIssue,
  type IDuplicateScanHandle,
} from './write/create-issue.js';
import { update as updateIssueOp } from './write/update.js';
import { transition as transitionIssueOp } from './write/transition.js';
import { claim as claimIssueOp } from './write/claim.js';
import { relate as relateIssueOp } from './write/relate.js';
import { move as moveIssueOp } from './write/move.js';
import { deleteIssue as deleteIssueOp } from './write/delete.js';
import {
  upsertProject as upsertProjectOp,
  upsertComponent as upsertComponentOp,
  upsertLocation as upsertLocationOp,
  rmLocation as rmLocationOp,
} from './write/catalog.js';

import type {
  IIssueGetInput,
  IIssueGetResult,
  IIssueQueryInput,
  IIssueQueryResult,
  ILookupResult,
} from './query/types.js';
import type {
  ICreateIssueInput,
  ICreateIssueResult,
} from './write/create-issue.js';
import type { IUpdateIssueInput, IUpdateIssueOutcome } from './write/update.js';
import type {
  ITransitionInput,
  ITransitionOutcome,
} from './write/transition.js';
import type { IClaimInput, IClaimOutcome } from './write/claim.js';
import type { IRelateInput, IRelateOutcome } from './write/relate.js';
import type { IMoveIssueInput, IMoveIssueOutcome } from './write/move.js';
import type { IDeleteIssueInput, IDeleteIssueOutcome } from './write/delete.js';
import type {
  IUpsertProjectInput,
  IUpsertProjectOutcome,
  IUpsertComponentInput,
  IUpsertComponentOutcome,
  IUpsertLocationInput,
  IUpsertLocationOutcome,
  IRmLocationInput,
  IRmLocationOutcome,
} from './write/catalog.js';

/** The one type apigen special-cases via the `ctx-name-only` invariant. */
export interface BacklogCtx {
  store: GraphBacklogStore;
  env: Environment<BacklogConfig>;
  /**
   * Per-process liveness holder for the `embedding.*` config family
   * (`write/embedding-config.ts`). Optional and additive: every existing
   * caller/test that builds a ctx by hand keeps the pre-existing resolve-once
   * behaviour exactly (`ctx.env.config.embedding` is the effective value).
   *
   * `startBacklogServer` attaches one; `ensureSemanticReady` refreshes it
   * before each semantic verb so an on-disk `config.yaml` edit is adopted
   * without a restart. `db.*`/`logging.level` are deliberately NOT covered —
   * they stay restart-required (see the holder's own doc comment).
   */
  embeddingConfig?: EmbeddingLiveConfig;
  /**
   * Test-isolation escape hatch ONLY — mirrors `BuildBacklogEnvOptions.adhdRoot`
   * (the same value passed to `buildBacklogEnv({ adhdRoot })` when constructing
   * `env`). NEVER set this in production code (`server.ts`/`cli.ts` never do).
   */
  adhdRoot?: string;
}

// ---------------------------------------------------------------------------
// ctx -> store-handle derivation
// ---------------------------------------------------------------------------

/**
 * The process's startup config hash (`ctx.env.version.configHash`), or
 * `undefined` when the ctx was built without one.
 *
 * `@adhd/environment`'s `Environment.version` is declared always-present, but
 * several specs construct a ctx by hand from a zero-config store
 * (`{ store, env: { config: {} } } as never` — see `envelope-codes.spec.ts`)
 * and those ctxs flow through this file's write/query path. Guarding here is
 * the same borrow-tolerance the absent `embedding` block already relies on: a
 * missing `version` must degrade the loudness metadata, not turn every verb
 * into an `internal` envelope.
 */
function startupConfigHash(ctx: BacklogCtx): string | undefined {
  return ctx.env.version?.configHash;
}

/**
 * The one lazy accessor every semantic-needing verb goes through, and the SOLE
 * call site of `bootstrapSemanticStoreMembers` (`write/bootstrap.ts`).
 *
 * SPEC.md §5b: the semantic backend is derived only when a verb's OWN input
 * needs it — `writeHandle`/`queryHandle` call this solely under their
 * `opts.needsSemantic` gate. `bootstrapSemanticStoreMembers` is itself
 * memoized per `StoreAdapter` (its own `membersCache`), so repeated calls in a
 * process share one provider/vector-store pair — never the two independent
 * bootstraps (and two cold ONNX loads) the previous eager path paid.
 *
 * Never throws on its own: `bootstrapSemanticStoreMembers` swallows every
 * failure internally and returns absent members, so a broken embedding backend
 * degrades exactly as before (a `create` still writes with `handle.embedding`
 * absent; a `claim`/`transition` never even attempts the bootstrap).
 *
 * ## Live config (`ctx.embeddingConfig`)
 *
 * The `embedding.*` family is the one RELOADABLE family: `@adhd/environment`
 * resolves its whole cascade once at construction, so a long-lived `serve`
 * would otherwise never observe an operator's `config.yaml` edit. Before each
 * semantic verb this refreshes the holder — a cheap stat pre-gate, then (only
 * on change) a fresh resolve whose `embedding.*` slice is adopted. An adoption
 * `resetSemanticStoreMembers` first, so the DISABLE direction retires the
 * otherwise process-lifetime member-ful derive; the ENABLE direction needs no
 * reset (a member-less derive was never retained) but is reset anyway for
 * symmetry and to make the transition atomic either way.
 *
 * `ctx.env` is never reassigned and `db.*`/`logging.level` are never adopted —
 * only `embedding.*` is passed on, and only from the holder's `current()`.
 */
async function ensureSemanticReady(
  ctx: BacklogCtx
): Promise<SemanticStoreMembers> {
  const live = ctx.embeddingConfig;
  if (live !== undefined && live.refresh().changed) {
    resetSemanticStoreMembers(ctx.store.adapter);
  }
  const cfg = live ? live.current() : ctx.env.config.embedding;
  return bootstrapSemanticStoreMembers(
    ctx.store.adapter,
    ctx.store.graph,
    cfg,
    undefined,
    {
      // Loudness signal for the DISABLED branch: `configured` is the on-disk
      // value (which, absent a refresh, can diverge from the effective one).
      configuredEnabled: live ? live.configured().enabled : cfg?.enabled,
      startupHash: startupConfigHash(ctx),
      configuredHash: live
        ? live.fingerprint().configHash
        : startupConfigHash(ctx),
      configPaths: live
        ? live.fingerprint().files.map((f) => f.path)
        : undefined,
    }
  );
}

/**
 * The write layer's handle. `typePolicy` is read off the store rather than
 * imported here, because the policy a write is validated against MUST be the
 * same instance the store's `GraphBackend` was constructed with — importing a
 * second copy is how the ETL/test/production divergence in
 * `store/type-policy.ts`'s header came about.
 *
 * `graph`/`search`/`embedding` come from `write/bootstrap.ts`
 * (`bootstrapSemanticStoreMembers`, memoized per `ctx.store.adapter`
 * instance — see its own doc comment) so `create-issue.ts`'s duplicate gate
 * (`IDuplicateScanHandle`) and `embedding-observer.ts`'s post-commit embed
 * round-trip (`IWriteStoreHandle.embedding`) are both genuinely wired in
 * production, not silent no-ops. `search`/`embedding` are absent whenever
 * `embedding.enabled` is off or the real backend could not start — the
 * honest degrade `bootstrap.ts` documents, never a stub.
 *
 * `opts.needsSemantic` is `true` only for `create`/`update` (the two verbs
 * with an on-write embed / duplicate-scan read); every other write verb passes
 * `false` and skips the bootstrap entirely (SPEC.md §5b point 3).
 */
async function writeHandle(
  ctx: BacklogCtx,
  opts: { needsSemantic: boolean }
): Promise<IWriteStoreHandle & IDuplicateScanHandle> {
  // Vocabulary guard (store/vocabulary-guard.ts): refuse to WRITE into a store
  // this build cannot address, rather than let the write fail downstream with
  // a misleading "project not found" caused by an unrecognized vocabulary.
  await assertRecognizedStoreVocabulary(ctx.store.adapter);
  const { search, embedding } = opts.needsSemantic
    ? await ensureSemanticReady(ctx)
    : {};
  return {
    adapter: ctx.store.adapter,
    typePolicy: ctx.store.typePolicy,
    graph: ctx.store.graph,
    ...(search !== undefined ? { search } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
  };
}

/**
 * The query layer's handle.
 *
 * `search` comes from `write/bootstrap.ts` (`bootstrapSemanticStoreMembers`,
 * memoized per `ctx.store.adapter` instance) — a real `StoreSearchBackend`
 * (`@adhd/sox-hybrid-search`) built from a real embedding model
 * (`@adhd/sox-embedding-provider`) resolved directly in `bootstrap.ts`,
 * opened against `ctx.store`'s own Turso adapter. It is absent whenever
 * `embedding.enabled` is off or the real backend could not start
 * (`bootstrap.ts`'s own doc comment) — `queryIssues` reads an absent
 * `search` as "semantic filters are unavailable" and SAYS so
 * (`InvalidArgumentError('semantic', ...)`), rather than silently falling
 * back to a substring scan or serving a stub's empty results. That is the
 * same rule BUG-045 settled for the vector space: an unwired search must
 * report as disabled, never as a working-but-empty one.
 *
 * `opts.needsSemantic` gates the bootstrap (SPEC.md §5b point 3) — a plain
 * `query` never pays the cold load. `opts.probeSpace` is set only for a bare
 * `text:` positional: routing that text between `semantic` and `grep` needs
 * to know whether the vector space actually holds anything, so the (async)
 * `search.spacePopulated()` probe is resolved here and snapshotted onto
 * `handle.spacePopulated` — `resolveTextInput` is synchronous and reads the
 * snapshot. `needsSemantic` is always `true` when `probeSpace` is (a `text:`
 * input satisfies `queryNeedsSemanticBackend`), so `search` is present
 * whenever the probe runs.
 */
async function queryHandle(
  ctx: BacklogCtx,
  opts: { needsSemantic: boolean; probeSpace: boolean }
): Promise<IQueryStoreHandle> {
  const { search } = opts.needsSemantic ? await ensureSemanticReady(ctx) : {};
  const spacePopulated =
    search !== undefined && opts.probeSpace
      ? await search.spacePopulated()
      : undefined;
  return {
    graph: ctx.store.graph,
    // Fail-loud vocabulary guard, re-run per query (never latched) — see
    // `IQueryStoreHandle.assertVocabulary` and store/vocabulary-guard.ts.
    assertVocabulary: () => assertRecognizedStoreVocabulary(ctx.store.adapter),
    ...(search !== undefined ? { search } : {}),
    ...(spacePopulated !== undefined ? { spacePopulated } : {}),
  };
}

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

/**
 * Maps the write layer's `E_*` code onto the envelope's `BacklogErrorCode`
 * vocabulary, which is what `BACKLOG_EXIT_CODE` (model.ts) keys the CLI's
 * process exit code off. The four rows that contract rests on are `E_VALIDATION`
 * (exit 2, a caller error) and `E_CONTENTION`/`E_IO`/`E_CONSTRAINT` (exit 1,
 * a server-side failure the caller cannot fix by re-phrasing the request).
 */
/**
 * Maps a thrown error CLASS onto the envelope's error code.
 *
 * **Why by class and not by the write layer's `E_*` code.** The write layer
 * classifies failures into four coarse buckets for its own retry logic, and
 * nine distinct error classes share `E_VALIDATION`. Keying the envelope off
 * that bucket collapsed all nine onto `validation`, so a claim held by another
 * agent, a missing issue, a terminal transition refused for want of a
 * citation, and a genuinely malformed flag were indistinguishable to a caller
 * — and, because the CLI derives its process exit code from this code, they
 * all exited 2 as if the caller had typed something wrong.
 *
 * Order matters: the list is walked top-down and the FIRST match wins, so
 * subclasses must precede their bases. `BacklogWriteError` is deliberately
 * absent — it is the base every entry here extends, and is handled as the
 * bucket fallback below.
 */
const ERROR_CLASS_TO_ENVELOPE_CODE: ReadonlyArray<
  readonly [new (...args: never[]) => Error, BacklogErrorCode]
> = [
  [IssueNotFoundError, 'item_not_found'],
  [CatalogNotFoundError, 'not_found'],
  [InvalidArgumentError, 'invalid_argument'],
  [ClaimHeldError, 'conflict'],
  [SingleValuedRelationConflictError, 'conflict'],
  [StaleSupersedeError, 'conflict'],
  [IssueTerminalError, 'precondition_failed'],
  [CitationRequiredError, 'precondition_failed'],
  [NoteRequiredError, 'precondition_failed'],
  [CitationUnverifiableError, 'precondition_failed'],
  [WriteContentionError, 'store_busy'],
  [RagNotConfiguredError, 'rag_not_configured'],
];

/**
 * Fallback for a `BacklogWriteError` subclass not named above — keyed off the
 * write layer's coarse bucket so a newly-added class still produces a sane
 * code rather than masquerading as `internal`.
 */
const WRITE_CODE_TO_ENVELOPE_CODE: Readonly<Record<string, BacklogErrorCode>> =
  {
    E_VALIDATION: 'validation',
    E_CONTENTION: 'store_busy',
    E_IO: 'internal',
    E_CONSTRAINT: 'conflict',
  };

/**
 * Translates a thrown implementation-layer error into the transport-facing
 * outcome error. A `BacklogWriteError` carries a classified code and is a
 * caller-visible failure; anything else is an unclassified bug in this
 * package and is reported as `internal` WITHOUT leaking its message shape
 * into the contract.
 */
function toEnvelope(err: unknown): IOutcomeFailure {
  for (const [ctor, code] of ERROR_CLASS_TO_ENVELOPE_CODE) {
    if (err instanceof ctor) {
      const details =
        err instanceof BacklogWriteError
          ? {
              retryable: err.retryable,
              ...(err.retry_after_ms === undefined
                ? {}
                : { retryAfterMs: err.retry_after_ms }),
            }
          : undefined;
      return errorEnvelope(code, err.message, details);
    }
  }
  if (err instanceof BacklogWriteError) {
    // `retryable`/`retry_after_ms` are the write layer's own contract
    // (ADR-0012 §4: `retryable` stays true even on exhaustion) and are
    // forwarded verbatim so a caller can honour the backoff the store
    // already measured. `errorEnvelope` defaults `retryable` for
    // `store_busy`; passing it explicitly keeps the two in agreement rather
    // than relying on that default.
    return errorEnvelope(
      WRITE_CODE_TO_ENVELOPE_CODE[err.code] ?? 'internal',
      err.message,
      {
        retryable: err.retryable,
        ...(err.retry_after_ms === undefined
          ? {}
          : { retryAfterMs: err.retry_after_ms }),
      }
    );
  }
  // Not a classified failure: a bug in this package, not something the caller
  // can fix by re-phrasing the request.
  return errorEnvelope(
    'internal',
    err instanceof Error ? err.message : String(err)
  );
}

/** Runs one verb body, mapping a throw onto the failure arm of the envelope. */
async function envelope<T>(
  run: () => Promise<T>
): Promise<IOutcomeEnvelope<T>> {
  try {
    return okEnvelope(await run());
  } catch (err) {
    return toEnvelope(err);
  }
}

// ---------------------------------------------------------------------------
// The mounted surface — nine issue verbs (SPEC §6.3) + `lookup` (§3a)
// ---------------------------------------------------------------------------

/**
 * Fetch one issue by `uid`, projected to the requested `fields`.
 *
 * Defaults to the same five-field card `query` returns
 * (`uid`, `kind`, `title`, `status`, `priority`).
 */
export async function get(
  ctx: BacklogCtx,
  input: IIssueGetInput
): Promise<IOutcomeEnvelope<IIssueGetResult>> {
  return envelope<IIssueGetResult>(() => {
    if ('registry' in input) {
      if (input.registry === 'project') {
        return getRegistryDetail(ctx.store.graph, {
          registry: 'project',
          name: input.name,
        });
      }
      if (input.registry === 'component') {
        return getRegistryDetail(ctx.store.graph, {
          registry: 'component',
          name: input.name,
          filter: input.filter,
        });
      }
      return getRegistryDetail(ctx.store.graph, {
        registry: 'location',
        name: input.name,
      });
    }
    return getIssue(ctx.store.graph, input);
  });
}

/**
 * Search, filter, group and paginate issues.
 *
 * Supports field projection, keyset and offset pagination, the `view`/`groupBy`
 * aggregate axes, and `grep`/`semantic` text filters.
 */
export async function query(
  ctx: BacklogCtx,
  input: IIssueQueryInput
): Promise<IOutcomeEnvelope<IIssueQueryResult>> {
  // Not routed through the generic `envelope()` helper: `query` is the one
  // verb whose success arm carries `meta` (SPEC.md's pagination-truth
  // contract, `envelope.ts`'s `IQueryEnvelopeMeta`) — `okEnvelope`'s `meta`
  // parameter is populated here, directly, rather than widening `envelope()`
  // for a field every other verb would leave meaningless.
  try {
    const { result, meta } = await queryIssuesWithMeta(
      await queryHandle(ctx, {
        needsSemantic: queryNeedsSemanticBackend(input),
        probeSpace: input.text !== undefined,
      }),
      input
    );
    return okEnvelope(result, meta ? { meta } : undefined);
  } catch (err) {
    return toEnvelope(err);
  }
}

/**
 * SPEC.md §5's status-aware priority matrix (BUG-023) — a per-priority
 * breakdown of issue counts, scoped by `project`/`component`/`kind`/`status`.
 *
 * An omitted `input.filter.status` scopes to OPEN work (a deliberate
 * divergence from `query`'s `list` default, where an omitted status means "no
 * restriction"); the applied scope is echoed on `data.statusScope`, so a
 * default-scoped result can never be mistaken for an all-status one. `{}` is a
 * valid input.
 *
 * A read op, NOT a `query.view` member: it returns a matrix
 * (`{rows, unassigned, statusScope}`) rather than a `{view, items}` list
 * permutation, and mounting it as a view would force `IIssueQueryInput` to
 * carry axes (`at`, an issue root) the other views must reject. Uses only
 * `handle.graph` — hence `needsSemantic:false`/`probeSpace:false`, so this op
 * never pays the cold semantic-backend bootstrap (`queryHandle`'s own doc
 * comment).
 */
export async function priorityMatrix(
  ctx: BacklogCtx,
  input: IPriorityMatrixInput
): Promise<IOutcomeEnvelope<IPriorityMatrixResult>> {
  return envelope(async () =>
    priorityMatrixView(
      await queryHandle(ctx, { needsSemantic: false, probeSpace: false }),
      input
    )
  );
}

/**
 * SPEC.md §5's `part_of` hierarchy rollup (FEAT-005) — every TRANSITIVE
 * descendant of the root issue `input.uid` via `part_of` (issue → issue,
 * `n:1`), counted exactly once each regardless of chain depth, split into
 * `childrenOpen`/`childrenClosed` (plus the open descendants' uids).
 *
 * A read op, NOT a `query.view` member: it is rooted at an issue (`uid`), a
 * per-op input no list view carries. Uses only `handle.graph` — see
 * {@link priorityMatrix}'s note on the `queryHandle` gates.
 */
export async function partOfRollup(
  ctx: BacklogCtx,
  input: IPartOfRollupInput
): Promise<IOutcomeEnvelope<IPartOfRollupResult>> {
  return envelope(async () =>
    partOfRollupView(
      await queryHandle(ctx, { needsSemantic: false, probeSpace: false }),
      input
    )
  );
}

/**
 * SPEC.md §5's `validAt` cumulative-open curve — for each sampled ISO-8601
 * instant in `input.at`, how many in-scope issues EXISTED then and, of those,
 * how many were reconstructed as OPEN then (never the issue's current status;
 * see `openCurve`'s own doc comment for the reconstruction rule).
 *
 * A read op, NOT a `query.view` member: it returns a time series
 * (`{points}`) keyed by a caller-given instant list, an axis no list view has.
 * Uses only `handle.graph` — see {@link priorityMatrix}'s note on the
 * `queryHandle` gates.
 */
export async function openCurve(
  ctx: BacklogCtx,
  input: IOpenCurveInput
): Promise<IOutcomeEnvelope<IOpenCurveResult>> {
  return envelope(async () =>
    openCurveView(
      await queryHandle(ctx, { needsSemantic: false, probeSpace: false }),
      input
    )
  );
}

/** The `embedding_status` read op's payload (see {@link embeddingStatus}). */
export interface IEmbeddingStatusResult {
  /** The on-disk `embedding.enabled` (observed from the config layers). */
  readonly configuredEnabled: boolean;
  /** The value the running process is actually using right now. */
  readonly effectiveEnabled: boolean;
  readonly provider: string;
  readonly model: string;
  /** Whether the resolved semantic members are currently retained for the store. */
  readonly membersPresent: {
    readonly embedding: boolean;
    readonly search: boolean;
  };
  /** `configuredEnabled !== effectiveEnabled` — on-disk enabled, process not (yet) adopted. */
  readonly divergent: boolean;
  /** Config hash the process started with (`ctx.env.version.configHash`). */
  readonly startupHash: string;
  /** Config hash currently observed on disk. */
  readonly currentHash: string;
}

/**
 * Health/observability read for the semantic layer: EFFECTIVE vs CONFIGURED
 * `embedding.*`, member presence, and both config hashes.
 *
 * A READ op — it never opens the cold semantic backend (`queryHandle` is not
 * touched), so a caller can ask "is RAG on, and is on-disk ahead of me?"
 * cheaply. `provider`/`model` are the effective values; `divergent` is the
 * one non-obvious bit — on-disk says enabled while the process is still
 * effectively disabled, which normally resolves on the next semantic verb
 * (see {@link ensureSemanticReady}).
 *
 * A first-class read op (rather than a `query` view) because it is a property
 * of the PROCESS and its config, not of the issue graph — and because the
 * write path's own loudness net (`write/bootstrap.ts`) reports the same
 * divergence, so operators can confirm it out-of-band.
 */
export async function embeddingStatus(
  ctx: BacklogCtx
): Promise<IOutcomeEnvelope<IEmbeddingStatusResult>> {
  return envelope<IEmbeddingStatusResult>(async () => {
    const live = ctx.embeddingConfig;
    // `configured()` observes the disk (adopting nothing), so read it before
    // `current()`: `divergent` then reflects the freshest on-disk value.
    const configured = live ? live.configured() : ctx.env.config.embedding;
    const effective = live ? live.current() : ctx.env.config.embedding;
    const peek = peekSemanticStoreMembers(ctx.store.adapter);
    return {
      configuredEnabled: configured?.enabled === true,
      effectiveEnabled: effective?.enabled === true,
      provider: effective?.provider ?? '',
      model: effective?.model ?? '',
      membersPresent: {
        embedding: peek?.embedding ?? false,
        search: peek?.search ?? false,
      },
      divergent:
        (configured?.enabled === true) !== (effective?.enabled === true),
      startupHash: startupConfigHash(ctx) ?? '',
      currentHash: live
        ? live.fingerprint().configHash
        : startupConfigHash(ctx) ?? '',
    };
  });
}

/**
 * Resolve a free-text reference to a project, component or location in the
 * registry.
 */
export async function lookup(
  ctx: BacklogCtx,
  input: { q: string }
): Promise<IOutcomeEnvelope<ILookupResult>> {
  return envelope(() => lookupRegistry(ctx.store.graph, input.q));
}

/** File a new issue, minting its `uid` and linking it to a project component. */
export async function create(
  ctx: BacklogCtx,
  input: ICreateIssueInput
): Promise<IOutcomeEnvelope<ICreateIssueResult>> {
  return envelope(async () =>
    createIssue(await writeHandle(ctx, { needsSemantic: true }), input)
  );
}

/**
 * Edit an existing issue.
 *
 * A `body` change supersedes the issue, minting a fresh `uid`; every other
 * change edits the existing node in place. `status` is not editable here —
 * use `transition`.
 */
export async function update(
  ctx: BacklogCtx,
  input: IUpdateIssueInput
): Promise<IOutcomeEnvelope<IUpdateIssueOutcome>> {
  return envelope(async () =>
    updateIssueOp(await writeHandle(ctx, { needsSemantic: true }), input)
  );
}

/** Move an issue to a new status, recording the transition in its audit trail. */
export async function transition(
  ctx: BacklogCtx,
  input: ITransitionInput
): Promise<IOutcomeEnvelope<ITransitionOutcome>> {
  return envelope(async () =>
    transitionIssueOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/** Take, renew or release an exclusive working lease on an issue. */
export async function claim(
  ctx: BacklogCtx,
  input: IClaimInput
): Promise<IOutcomeEnvelope<IClaimOutcome>> {
  return envelope(async () =>
    claimIssueOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/** Create or remove a typed relationship between two issues. */
export async function relate(
  ctx: BacklogCtx,
  input: IRelateInput
): Promise<IOutcomeEnvelope<IRelateOutcome>> {
  return envelope(async () =>
    relateIssueOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/** Re-file an issue under a different project component. */
export async function move(
  ctx: BacklogCtx,
  input: IMoveIssueInput
): Promise<IOutcomeEnvelope<IMoveIssueOutcome>> {
  return envelope(async () =>
    moveIssueOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/**
 * Soft-delete an issue.
 *
 * The node is closed off bi-temporally, never physically removed — its audit
 * trail and every edge pointing at it remain readable.
 */
async function remove(
  ctx: BacklogCtx,
  input: IDeleteIssueInput
): Promise<IOutcomeEnvelope<IDeleteIssueOutcome>> {
  return envelope(async () =>
    deleteIssueOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

// ---------------------------------------------------------------------------
// Registry CRUD (SPEC §3a) — project/component/location upsert + location removal
// ---------------------------------------------------------------------------

/**
 * Create or update a project by `name`.
 *
 * On first creation, also mints the project's reserved default component
 * `(root)`. A repeat call against an existing project is idempotent.
 */
export async function upsertProject(
  ctx: BacklogCtx,
  input: IUpsertProjectInput
): Promise<IOutcomeEnvelope<IUpsertProjectOutcome>> {
  return envelope(async () =>
    upsertProjectOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/** Create or update a component by `(project, name)`. */
export async function upsertComponent(
  ctx: BacklogCtx,
  input: IUpsertComponentInput
): Promise<IOutcomeEnvelope<IUpsertComponentOutcome>> {
  return envelope(async () =>
    upsertComponentOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/**
 * Create or find a location by `(component, locType, value)`.
 *
 * A component referenced by bare name (rather than uid) requires `project`
 * to disambiguate it.
 */
export async function upsertLocation(
  ctx: BacklogCtx,
  input: IUpsertLocationInput
): Promise<IOutcomeEnvelope<IUpsertLocationOutcome>> {
  return envelope(async () =>
    upsertLocationOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/** Soft-remove a location by `uid`. */
export async function rmLocation(
  ctx: BacklogCtx,
  input: IRmLocationInput
): Promise<IOutcomeEnvelope<IRmLocationOutcome>> {
  return envelope(async () =>
    rmLocationOp(await writeHandle(ctx, { needsSemantic: false }), input)
  );
}

/**
 * SPEC §6.7 names this verb `delete` on every mount (`backlog_delete`,
 * `backlog delete`, `DELETE /issue`). `export async function delete` is a
 * syntax error — `delete` is a reserved word — but an export CLAUSE may alias
 * to any IdentifierName, reserved words included, and apigen resolves the
 * mounted name from `sf.getExportedDeclarations()` (ts-morph's own
 * rename/re-export resolver, which extract.ts documents as covering "named
 * exports — local, renamed, AND re-exported"). So the operation mounts as
 * `delete` while the implementation keeps a legal identifier.
 *
 * Do NOT "simplify" this to `export async function remove`: that silently
 * renames the tool to `backlog_remove` on all four transports.
 */
export { remove as delete };
