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
import type { IOutcomeEnvelope, IOutcomeFailure, BacklogErrorCode } from './model.js';
import { errorEnvelope, okEnvelope } from './model.js';
import { BacklogWriteError } from './write/errors.js';
import { bootstrapSemanticStoreMembers } from './write/bootstrap.js';

import { getIssue } from './query/get.js';
import { queryIssues } from './query/query.js';
import { lookup as lookupRegistry } from './query/views/registry.js';
import { createIssue, type IDuplicateScanHandle } from './write/create-issue.js';
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
  IIssueCard,
  IIssueGetInput,
  IIssueQueryInput,
  IIssueQueryResult,
  ILookupResult,
} from './query/types.js';
import type { ICreateIssueInput, ICreateIssueResult } from './write/create-issue.js';
import type { IUpdateIssueInput, IUpdateIssueOutcome } from './write/update.js';
import type { ITransitionInput, ITransitionOutcome } from './write/transition.js';
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
 */
async function writeHandle(ctx: BacklogCtx): Promise<IWriteStoreHandle & IDuplicateScanHandle> {
  const { search, embedding } = await bootstrapSemanticStoreMembers(ctx.store.adapter, ctx.store.graph, ctx.env.config.embedding);
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
 */
async function queryHandle(ctx: BacklogCtx): Promise<IQueryStoreHandle> {
  const { search } = await bootstrapSemanticStoreMembers(ctx.store.adapter, ctx.store.graph, ctx.env.config.embedding);
  return { graph: ctx.store.graph, ...(search !== undefined ? { search } : {}) };
}

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

/**
 * Maps the write layer's `E_*` code onto the envelope's `BacklogErrorCode`
 * vocabulary, which is what `BACKLOG_EXIT_CODE` (model.ts) keys the CLI's
 * process exit code off. The four rows AC-6 depends on are `E_VALIDATION`
 * (exit 2, a caller error) and `E_CONTENTION`/`E_IO`/`E_CONSTRAINT` (exit 1,
 * a server-side failure the caller cannot fix by re-phrasing the request).
 */
const WRITE_CODE_TO_ENVELOPE_CODE: Readonly<Record<string, BacklogErrorCode>> = {
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
  if (err instanceof BacklogWriteError) {
    const code = WRITE_CODE_TO_ENVELOPE_CODE[err.code] ?? 'internal';
    // `retryable`/`retry_after_ms` are the write layer's own contract
    // (ADR-0012 §4: `retryable` stays true even on exhaustion) and are
    // forwarded verbatim so a caller can honour the backoff the store
    // already measured. `errorEnvelope` defaults `retryable` for
    // `store_busy`; passing it explicitly keeps the two in agreement rather
    // than relying on that default.
    return errorEnvelope(code, err.message, {
      retryable: err.retryable,
      ...(err.retry_after_ms === undefined ? {} : { retryAfterMs: err.retry_after_ms }),
    });
  }
  // Not a classified failure: a bug in this package, not something the caller
  // can fix by re-phrasing the request.
  return errorEnvelope('internal', err instanceof Error ? err.message : String(err));
}

/** Runs one verb body, mapping a throw onto the failure arm of the envelope. */
async function envelope<T>(run: () => Promise<T>): Promise<IOutcomeEnvelope<T>> {
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
export async function get(ctx: BacklogCtx, input: IIssueGetInput): Promise<IOutcomeEnvelope<IIssueCard>> {
  return envelope(() => getIssue(ctx.store.graph, input));
}

/**
 * Search, filter, group and paginate issues.
 *
 * Supports field projection, keyset and offset pagination, the `view`/`groupBy`
 * aggregate axes, and `grep`/`semantic` text filters.
 */
export async function query(ctx: BacklogCtx, input: IIssueQueryInput): Promise<IOutcomeEnvelope<IIssueQueryResult>> {
  return envelope(async () => queryIssues(await queryHandle(ctx), input));
}

/**
 * Resolve a free-text reference to a project, component or location in the
 * registry.
 */
export async function lookup(ctx: BacklogCtx, input: { q: string }): Promise<IOutcomeEnvelope<ILookupResult>> {
  return envelope(() => lookupRegistry(ctx.store.graph, input.q));
}

/** File a new issue, minting its `uid` and linking it to a project component. */
export async function create(ctx: BacklogCtx, input: ICreateIssueInput): Promise<IOutcomeEnvelope<ICreateIssueResult>> {
  return envelope(async () => createIssue(await writeHandle(ctx), input));
}

/**
 * Edit an existing issue.
 *
 * A `body` change supersedes the issue, minting a fresh `uid`; every other
 * change edits the existing node in place. `status` is not editable here —
 * use `transition`.
 */
export async function update(ctx: BacklogCtx, input: IUpdateIssueInput): Promise<IOutcomeEnvelope<IUpdateIssueOutcome>> {
  return envelope(async () => updateIssueOp(await writeHandle(ctx), input));
}

/** Move an issue to a new status, recording the transition in its audit trail. */
export async function transition(ctx: BacklogCtx, input: ITransitionInput): Promise<IOutcomeEnvelope<ITransitionOutcome>> {
  return envelope(async () => transitionIssueOp(await writeHandle(ctx), input));
}

/** Take, renew or release an exclusive working lease on an issue. */
export async function claim(ctx: BacklogCtx, input: IClaimInput): Promise<IOutcomeEnvelope<IClaimOutcome>> {
  return envelope(async () => claimIssueOp(await writeHandle(ctx), input));
}

/** Create or remove a typed relationship between two issues. */
export async function relate(ctx: BacklogCtx, input: IRelateInput): Promise<IOutcomeEnvelope<IRelateOutcome>> {
  return envelope(async () => relateIssueOp(await writeHandle(ctx), input));
}

/** Re-file an issue under a different project component. */
export async function move(ctx: BacklogCtx, input: IMoveIssueInput): Promise<IOutcomeEnvelope<IMoveIssueOutcome>> {
  return envelope(async () => moveIssueOp(await writeHandle(ctx), input));
}

/**
 * Soft-delete an issue.
 *
 * The node is closed off bi-temporally, never physically removed — its audit
 * trail and every edge pointing at it remain readable.
 */
async function remove(ctx: BacklogCtx, input: IDeleteIssueInput): Promise<IOutcomeEnvelope<IDeleteIssueOutcome>> {
  return envelope(async () => deleteIssueOp(await writeHandle(ctx), input));
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
export async function upsertProject(ctx: BacklogCtx, input: IUpsertProjectInput): Promise<IOutcomeEnvelope<IUpsertProjectOutcome>> {
  return envelope(async () => upsertProjectOp(await writeHandle(ctx), input));
}

/** Create or update a component by `(project, name)`. */
export async function upsertComponent(ctx: BacklogCtx, input: IUpsertComponentInput): Promise<IOutcomeEnvelope<IUpsertComponentOutcome>> {
  return envelope(async () => upsertComponentOp(await writeHandle(ctx), input));
}

/**
 * Create or find a location by `(component, locType, value)`.
 *
 * A component referenced by bare name (rather than uid) requires `project`
 * to disambiguate it.
 */
export async function upsertLocation(ctx: BacklogCtx, input: IUpsertLocationInput): Promise<IOutcomeEnvelope<IUpsertLocationOutcome>> {
  return envelope(async () => upsertLocationOp(await writeHandle(ctx), input));
}

/** Soft-remove a location by `uid`. */
export async function rmLocation(ctx: BacklogCtx, input: IRmLocationInput): Promise<IOutcomeEnvelope<IRmLocationOutcome>> {
  return envelope(async () => rmLocationOp(await writeHandle(ctx), input));
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
