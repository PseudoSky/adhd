/**
 * ops-v1.ts — the v1 operation bodies, moved VERBATIM out of `client.ts` by
 * INTERFACE_v2 C-01 (the six-verb collapse).
 *
 * Why this file exists at all: `server.ts`'s `extractClientOperations()`
 * extracts `dist/client.d.ts` — the WHOLE file, with no allow-list — so
 * EVERY exported function in `client.ts` becomes a mounted operation on
 * every transport (`server.ts:349-380`). `client.ts` used to export 38 of
 * them; the v2 surface is exactly six (`BACKLOG_V2_TOOLS`, model.ts). Those
 * 38 therefore cannot stay exported from `client.ts` — not because they are
 * wrong, but because being exported from THAT file is what mounts them.
 *
 * So they live here instead: same functions, same signatures, same
 * behaviour, one module away from the extraction surface. `client.ts`'s six
 * verbs compose them; `src/v2/*.ts` delegates to them; `index.ts` re-exports
 * them for in-process library consumers. Nothing here is a public wire
 * surface any more — the six verbs are.
 *
 * `ctx: BacklogCtx` stays the first parameter of every function even though
 * nothing extracts this file: these are the same functions, and a caller
 * moving a call site between here and `client.ts` should not have to
 * re-shape it.
 */
import type {
  ArchiveOpts,
  ArchiveResult,
  AuditTrailResult,
  BacklogFilter,
  BacklogItem,
  BacklogStats,
  BacklogStatus,
  ClaimOpts,
  ClaimResult,
  Citation,
  CreateItemInput,
  CreateItemResult,
  DependencyGraph,
  ILinkRelatedResult,
  ImportMarkdownInput,
  ImportResult,
  MigrationPhase,
  MigrationStatusResult,
  Priority,
  ReleaseResult,
  RepoMigrationResult,
  SetMigrationPhaseResult,
  StatsScope,
  TopoOrderResult,
  TransitionOpts,
  UpdateItemInput,
} from './model.js';
import { isTerminalStatus, requiresCitation, requiresReason } from './model.js';
import type { GraphBacklogStore } from './store/graph-backlog-store.js';
import { createItemNode, getItemNode, softDeleteItemNode, updateItemNode } from './store/crud.js';
import { auditTrail as auditTrailNode, blockers as blockersNode, buildNotFoundError, computeStats, dependencyGraph as dependencyGraphNode, knownRepos, listItems as listItemsNode, queryItemNodes, readyItems as readyItemsNode, spotlight as spotlightNode, staleClaims as staleClaimsNode, topoOrder as topoOrderNode } from './store/query.js';
import { toBacklogItem } from './store/mapping.js';
import { claimItemNode, releaseClaimNode, renewClaimNode } from './store/claim.js';
import { addCitationNode, appendNoteNode, archiveTerminalItems, resolveItemNode, startWorkNode, transitionStatusNode } from './store/lifecycle.js';
import { addDependencyNode, assignItemNode, attachToPlanNode, linkRelatedNode, mergeItemsNode, removeDependencyNode, setPriorityNode, splitItemNode, supersedeItemNode } from './store/structure.js';
import { migrateRepo as migrateRepoNode } from './store/repo-migration.js';
import { buildChangelogSection, parseBacklogMarkdownWithDiagnostics, renderItemsToMarkdown, toImportItems } from './markdown.js';
import type { RenderGrammarOptions } from './markdown.js';
import { readFileSync } from 'node:fs';
import { readBacklogVersionInfo } from './version-info.js';
import { readBacklogMigrationStatus, setBacklogMigrationPhase } from './migration-phase.js';

import type { BacklogCtx } from './client.js';

async function requireItem(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem> {
  const item = await getItemNode(ctx.store, repo, humanId);
  if (!item) throw await buildNotFoundError(ctx.store, repo, humanId);
  return item;
}

// ============================================================================
// §5.1 — CRUD
// ============================================================================

/**
 * Dedupe-scans (FTS + symbol/path/errorText metadata match) before writing.
 * Allocates humanId as family + next number within (repo, family) unless
 * idOverride is given.
 */
export async function createItem(ctx: BacklogCtx, input: CreateItemInput): Promise<CreateItemResult> {
  return createItemNode(ctx.store, input);
}

/**
 * repo is required — humanId alone is not globally unique. A genuine miss
 * (humanId doesn't exist under ANY repo) still returns `null` — unchanged,
 * every existing caller relying on nullable-not-throwing keeps working.
 *
 * BUG-BACKLOG-REPO-LOOKUP-UX-001: previously a repo/humanId MISMATCH (the
 * item is live, just filed under a different `repo` string) was
 * indistinguishable from a genuine miss — both silently returned `null`,
 * which is worse than `appendNote`'s bare-but-at-least-thrown
 * `BacklogItemNotFoundError` (and, before this fix, could surface through
 * apigen's MCP layer as the unrelated broken int64/null encoding,
 * BUG-APIGEN-LOGICAL-NULL-OBJECT-RESULT-INT64-001 — out of scope here, but
 * this fix removes the only path that made this lookup look like that bug).
 * Now: a real cross-repo match THROWS the same informative
 * `BacklogItemNotFoundError` (with `foundInRepos` naming the actual repo) the
 * mutating lookups already throw, instead of masquerading as "not found".
 */
export async function getItem(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem | null> {
  const item = await getItemNode(ctx.store, repo, humanId);
  if (item) return item;
  const notFound = await buildNotFoundError(ctx.store, repo, humanId);
  if (notFound.foundInRepos.length > 0) throw notFound;
  return null;
}

export async function updateItem(ctx: BacklogCtx, repo: string, humanId: string, patch: UpdateItemInput): Promise<BacklogItem> {
  return updateItemNode(ctx.store, repo, humanId, patch);
}

export async function listItems(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]> {
  return listItemsNode(ctx.store, filter ?? {});
}

/** Invalidates the node (bi-temporal — never a hard delete). */
export async function softDeleteItem(ctx: BacklogCtx, repo: string, humanId: string, reason: string): Promise<void> {
  await softDeleteItemNode(ctx.store, repo, humanId, reason);
}

// ============================================================================
// §5.2 — Query / report
// ============================================================================

export async function stats(ctx: BacklogCtx, scope?: StatsScope): Promise<BacklogStats> {
  return computeStats(ctx.store, scope ?? {});
}

/** Open + prioritized, most-severe first. */
export async function spotlight(ctx: BacklogCtx, scope?: StatsScope, limit?: number): Promise<BacklogItem[]> {
  return spotlightNode(ctx.store, scope ?? {}, limit ?? 20);
}

/** Open items whose every DEPENDS_ON target is a terminal status AND which are not currently claimed. */
export async function readyItems(ctx: BacklogCtx, scope?: StatsScope): Promise<BacklogItem[]> {
  return readyItemsNode(ctx.store, scope ?? {});
}

/** The DEPENDS_ON set of `humanId` that is NOT yet terminal. */
export async function blockers(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem[]> {
  return blockersNode(ctx.store, repo, humanId);
}

export async function dependencyGraph(ctx: BacklogCtx, scope?: StatsScope): Promise<DependencyGraph> {
  return dependencyGraphNode(ctx.store, scope ?? {});
}

export async function topoOrder(ctx: BacklogCtx, scope?: StatsScope): Promise<TopoOrderResult> {
  return topoOrderNode(ctx.store, scope ?? {});
}

/** Items whose claim lease is older than maxAgeMin with no renewal — candidates for --force reclaim. */
export async function staleClaims(ctx: BacklogCtx, maxAgeMin: number, scope?: StatsScope): Promise<BacklogItem[]> {
  return staleClaimsNode(ctx.store, maxAgeMin, scope ?? {});
}

// ============================================================================
// §5.3 — Multi-agent coordination
// ============================================================================

export async function claimItem(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: ClaimOpts): Promise<ClaimResult> {
  const node = await requireItem(ctx, repo, humanId);
  return claimItemNode(ctx.store, node.nodeId, by, opts ?? {});
}

/** Same-claimant renewal — always succeeds (bumps claimedAt), no contention check. */
export async function renewClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string): Promise<ClaimResult> {
  const node = await requireItem(ctx, repo, humanId);
  return renewClaimNode(ctx.store, node.nodeId, by);
}

export async function releaseClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: { force?: boolean }): Promise<ReleaseResult> {
  const node = await requireItem(ctx, repo, humanId);
  return releaseClaimNode(ctx.store, node.nodeId, by, opts ?? {});
}

/** Durable ownership (planner decision) — distinct from the ephemeral claim lease. */
export async function assignItem(ctx: BacklogCtx, repo: string, humanId: string, to: string, by: string): Promise<BacklogItem> {
  return assignItemNode(ctx.store, repo, humanId, to, by);
}

// ============================================================================
// §5.4 — Lifecycle
// ============================================================================

/** transitionStatus(id, 'IN_PROGRESS', ...) + an implicit claimItem(id, by) — a no-op claim-wise if already held by `by`. */
export async function startWork(ctx: BacklogCtx, repo: string, humanId: string, by: string): Promise<BacklogItem> {
  return startWorkNode(ctx.store, repo, humanId, by);
}

export async function transitionStatus(ctx: BacklogCtx, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem> {
  return transitionStatusNode(ctx.store, repo, humanId, status, opts);
}

export async function addCitation(ctx: BacklogCtx, repo: string, humanId: string, citation: Citation): Promise<BacklogItem> {
  return addCitationNode(ctx.store, repo, humanId, citation);
}

export async function appendNote(ctx: BacklogCtx, repo: string, humanId: string, by: string, text: string): Promise<BacklogItem> {
  return appendNoteNode(ctx.store, repo, humanId, by, text);
}

/** Sugar for transitionStatus into any terminal status. */
export async function resolveItem(ctx: BacklogCtx, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem> {
  return resolveItemNode(ctx.store, repo, humanId, status, opts);
}

/**
 * Renders terminal items to CHANGELOG.md-formatted markdown and marks them
 * archived (metadata.archivedAt set) so renderToMarkdown's default view
 * excludes them — the graph node itself is NEVER deleted.
 */
export async function archiveResolved(ctx: BacklogCtx, scope: StatsScope, opts?: ArchiveOpts): Promise<ArchiveResult> {
  const archived = await archiveTerminalItems(ctx.store, scope, opts ?? {});
  const changelogMarkdown = archived.length > 0 ? buildChangelogSection(archived, new Date().toISOString().slice(0, 10)) : '';
  return { archivedCount: archived.length, changelogMarkdown };
}

// ============================================================================
// §5.5 — Structure
// ============================================================================

/** `targetRepo` — see `addDependencyNode`'s doc comment (store/structure.ts). */
export async function addDependency(
  ctx: BacklogCtx,
  repo: string,
  humanId: string,
  dependsOnHumanId: string,
  targetRepo?: string
): Promise<{ alreadyExisted: boolean }> {
  return addDependencyNode(ctx.store, repo, humanId, dependsOnHumanId, targetRepo);
}

/** `targetRepo` — see `removeDependencyNode`'s doc comment (store/structure.ts). */
export async function removeDependency(
  ctx: BacklogCtx,
  repo: string,
  humanId: string,
  dependsOnHumanId: string,
  targetRepo?: string
): Promise<{ alreadyExisted: boolean }> {
  return removeDependencyNode(ctx.store, repo, humanId, dependsOnHumanId, targetRepo);
}

/** `targetRepo` — see `linkRelatedNode`'s doc comment (store/structure.ts). */
export async function linkRelated(ctx: BacklogCtx, repo: string, humanIdA: string, humanIdB: string, targetRepo?: string): Promise<ILinkRelatedResult> {
  return linkRelatedNode(ctx.store, repo, humanIdA, humanIdB, targetRepo);
}

/** Mints a new item, links new SUPERSEDES old, invalidates old with reason. */
export async function supersedeItem(ctx: BacklogCtx, repo: string, oldHumanId: string, newInput: CreateItemInput, reason: string): Promise<BacklogItem> {
  return supersedeItemNode(ctx.store, repo, oldHumanId, newInput, reason);
}

/** Creates N children linked child PART_OF parent. Parent is left open. */
export async function splitItem(ctx: BacklogCtx, repo: string, parentHumanId: string, children: CreateItemInput[]): Promise<BacklogItem[]> {
  return splitItemNode(ctx.store, repo, parentHumanId, children);
}

/** SAME_AS(drop -> keep), invalidates drop with an auto-generated reason. */
export async function mergeItems(ctx: BacklogCtx, repo: string, keepHumanId: string, dropHumanId: string, reason: string): Promise<BacklogItem> {
  return mergeItemsNode(ctx.store, repo, keepHumanId, dropHumanId, reason);
}

export async function setPriority(ctx: BacklogCtx, repo: string, humanId: string, priority: Priority): Promise<BacklogItem> {
  return setPriorityNode(ctx.store, repo, humanId, priority);
}

/**
 * MEMBER_OF edge to a plan node (auto-created if the plan slug hasn't been
 * seen before). `planRepo` — see `attachToPlanNode`'s doc comment (store/structure.ts).
 */
export async function attachToPlan(ctx: BacklogCtx, repo: string, humanId: string, planSlug: string, planRepo?: string): Promise<{ alreadyExisted: boolean }> {
  return attachToPlanNode(ctx.store, repo, humanId, planSlug, planRepo);
}

/**
 * BUG-BACKLOG-REPO-SPLIT-001 / DEBT-BACKLOG-REPO-MOVE-001 — the dedicated
 * primitive to move every live item out of `fromRepo` into `toRepo` (a
 * repo-key correction, e.g. a legacy `"adhd"` string onto the canonical
 * `"PseudoSky/adhd"`). `dryRun` defaults to `true`: a caller must pass
 * `dryRun:false` explicitly to write anything — the default call is always
 * safe to make speculatively and returns the full plan (including which
 * items would be renamed, and to what) with zero mutation.
 *
 * Collisions (a humanId already live in `toRepo`) are never silently
 * dropped, overwritten, or left ambiguous — each is deterministically
 * renamed to the next free number in its own family within `toRepo`
 * (`store/repo-migration.ts`'s `planRepoMigration`), and an audit note
 * recording the original `(fromRepo, humanId)` is attached to the moved
 * item so the rename is traceable. Cross-item links (DEPENDS_ON,
 * RELATES_TO, PART_OF, SUPERSEDES, SAME_AS, MEMBER_OF, ASSIGNED_TO) are
 * preserved automatically — a move never changes a node's id, only its
 * `namespace`/`repo`/`humanId`/`name`/`content`.
 *
 * Every planned item gets exactly one reported outcome
 * (`results[i].ok`/`error`) when `dryRun:false` — a per-item failure never
 * aborts the rest of the batch and never goes unreported.
 */
export async function migrateRepo(ctx: BacklogCtx, fromRepo: string, toRepo: string, by: string, dryRun?: boolean): Promise<RepoMigrationResult> {
  return migrateRepoNode(ctx.store, fromRepo, toRepo, by, dryRun ?? true);
}

// ============================================================================
// §5.6 — Interop
// ============================================================================

export async function importFromMarkdown(ctx: BacklogCtx, input: ImportMarkdownInput): Promise<ImportResult> {
  const text = readFileSync(input.path, 'utf8');
  const { items: parsed, malformedHeaders, duplicateHeaders } = parseBacklogMarkdownWithDiagnostics(text);
  const items = toImportItems(parsed);
  // Defaults to `path` (the file actually read) — a caller only needs to set
  // `sourcePath` explicitly when importing from a scratch copy but wanting
  // the ORIGINAL path recorded as provenance (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001).
  const sourcePath = input.sourcePath ?? input.path;

  // BUG-BACKLOG-REPO-LOOKUP-UX-001 (write-time half): same soft, non-blocking
  // check `createItemNode` runs per item — computed ONCE here since the whole
  // import shares one `input.repo`, not per item.
  const known = await knownRepos(ctx.store);
  const repoWarning =
    known.size > 0 && !known.has(input.repo)
      ? `repo '${input.repo}' is new to this store — existing repo value(s) here: ${[...known].sort().join(', ')}. If this is meant to be the same project, use the existing repo value instead.`
      : undefined;

  const result: ImportResult = {
    parsed: items.length,
    created: 0,
    skippedDuplicates: 0,
    updated: 0,
    errors: [],
    malformedHeaders,
    duplicateHeaders,
    ...(repoWarning !== undefined ? { repoWarning } : {}),
  };
  if (input.dryRun) return result;

  for (const item of items) {
    try {
      const created = await createItemNode(ctx.store, {
        family: item.humanId.replace(/-\d+$/, ''),
        idOverride: item.humanId,
        title: item.title,
        body: item.body,
        repo: input.repo,
        ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        importedFrom: sourcePath,
        ...(item.priority !== undefined ? { priority: item.priority } : {}),
        force: true,
      });
      if (created.created && input.plan !== undefined) {
        // `attachToPlan` also writes the `MEMBER_OF` edge to the plan node
        // (createItemNode's `plan` above only stamps the `metadata.plan`
        // field) — both are needed for `renderToMarkdown({plan})`'s
        // filtered-projection scope model (MIGRATION.md §2.2).
        await attachToPlanNode(ctx.store, input.repo, item.humanId, input.plan);
      }
      if (created.created && item.status !== 'OPEN') {
        // createItem always starts OPEN (SPEC.md §4.2 rule 1) — apply the
        // parsed status as a follow-up transition so import is idempotent
        // AND preserves the source file's real status. Only attach the
        // evidence the status-vocabulary gate actually requires (SPEC.md
        // §4.2 rule 3) — an imported OPEN/IN_PROGRESS/BLOCKED/... item needs
        // neither.
        await transitionStatusNode(ctx.store, input.repo, item.humanId, item.status, {
          by: 'system:importFromMarkdown',
          ...(requiresCitation(item.status) ? { citations: [{ file: input.path }] } : {}),
          ...(requiresReason(item.status) ? { reason: `imported from markdown at status ${item.status}` } : {}),
        });
      }
      if (created.created) {
        result.created += 1;
        continue;
      }
      result.skippedDuplicates += 1;

      // BUG-BACKLOG-IMPORT-INSERT-ONLY-NO-UPDATE-001: an already-live
      // humanId used to be a pure no-op forever, even when the SOURCE
      // markdown's title/body/priority/status had genuinely changed since
      // the first import (e.g. a bug got fixed and its status/body updated
      // directly in BACKLOG.md) — a re-import could never converge the
      // graph with the live file short of a full re-seed. Diff against the
      // CURRENT graph copy and refresh only what actually changed; an
      // unchanged item stays a true no-op (never touches the store).
      const existing = created.duplicateCandidates[0] ?? created.item;
      let changed = false;

      // DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001: a humanId can legitimately
      // be repeated across files two ways — (a) the SAME file re-importing
      // its own content (title/body/priority/status/projectPath all belong
      // to that file, refresh them all), or (b) a DIFFERENT file
      // cross-referencing an id whose canonical content/scope lives
      // elsewhere (a plan file citing a root-BACKLOG.md item, or a package
      // file citing another package's finding) — a cross-reference must
      // never clobber the OWNING file's title/body/projectPath (confirmed
      // this session: without this guard, re-importing a plan-file's
      // shorter pointer entry AFTER its root BACKLOG.md counterpart
      // permanently overwrote the root item's richer title/body on every
      // pass). Ownership is "whichever file's import first created this
      // node" (`existing.importedFrom`, stamped once at create time and
      // never touched by an update — DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001
      // — so ownership survives regardless of later re-import order/drift).
      // `existing.importedFrom` can be unset only for an item created
      // before that provenance field existed; treat that as "no recorded
      // owner yet" and let this import claim ownership going forward,
      // matching the pre-existing (unguarded) behavior for such legacy rows.
      const isOwningImport = existing.importedFrom === undefined || existing.importedFrom === sourcePath;

      if (isOwningImport) {
        const patch: UpdateItemInput = {};
        if (existing.title !== item.title) patch.title = item.title;
        if (existing.body !== item.body) patch.body = item.body;
        // BUG-BACKLOG-IMPORT-OWNERSHIP-NOT-BACKFILLED-001: line 332 treats a
        // legacy row whose `importedFrom` was never stamped (created before
        // the provenance field existed) as "let this import claim ownership
        // going forward" — but the owning branch never actually WROTE the
        // stamp, so such rows stayed `importedFrom===undefined` permanently
        // and the ownership-based root projection filter
        // (`{importedFrom:'BACKLOG.md'}`, MIGRATION.md §2.2) could never see
        // them (142 of 147 root items were invisible pre-fix). Backfill the
        // stamp ONCE here, and only when unset — an already-owned row's
        // provenance stays immutable (the isOwningImport guard already
        // requires `existing.importedFrom === sourcePath` in that case).
        if (existing.importedFrom === undefined) patch.importedFrom = sourcePath;
        // Symmetric with `plan` below (BUG-BACKLOG-IMPORT-PROJECTPATH-STALE-001,
        // part of DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001) — previously the
        // upsert diff refreshed title/body/priority/status/plan but had NO
        // branch for `projectPath` at all, so an item's scope stuck
        // permanently at whichever file happened to import it FIRST, ever,
        // even after its canonical write-up relocated to a different
        // package's BACKLOG.md.
        if (input.projectPath !== undefined && existing.projectPath !== input.projectPath) {
          patch.projectPath = input.projectPath;
        }
        if (Object.keys(patch).length > 0) {
          await updateItemNode(ctx.store, input.repo, item.humanId, patch);
          changed = true;
        }

        if (item.priority !== undefined && existing.priority !== item.priority) {
          await setPriorityNode(ctx.store, input.repo, item.humanId, item.priority);
          changed = true;
        }

        if (existing.status !== item.status) {
          await transitionStatusNode(ctx.store, input.repo, item.humanId, item.status, {
            by: 'system:importFromMarkdown',
            ...(requiresCitation(item.status) ? { citations: [{ file: input.path }] } : {}),
            ...(requiresReason(item.status) ? { reason: `re-imported from markdown at status ${item.status}` } : {}),
          });
          changed = true;
        }
      }

      // Plan attachment is deliberately NOT gated by ownership — a
      // cross-referencing file's entire purpose is to declare "this item
      // also belongs to my plan", so a non-owning import must still be able
      // to attach it. Idempotent (writeEdge upserts on the same src/dst/rel
      // triple) — safe to re-assert on every re-import, including an
      // otherwise unchanged item, so an item's plan attachment is never
      // permanently missed just because it was first imported before
      // `input.plan` was set.
      if (input.plan !== undefined && existing.plan !== input.plan) {
        await attachToPlanNode(ctx.store, input.repo, item.humanId, input.plan);
        changed = true;
      }

      if (changed) result.updated += 1;
    } catch (err) {
      result.errors.push({ humanId: item.humanId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Excludes archived items (SPEC.md §5.4 archiveResolved) — see markdown.ts's
 * renderItemsToMarkdown doc comment. Archival exclusion goes through
 * `BacklogFilter.excludeArchived` (query.ts's `applyExcludeArchivedFilter`)
 * rather than a private scan here, so a caller comparing this output
 * against `listItems`/`queryItemNodes` for the SAME filter (e.g.
 * `render-projections.mjs`'s round-trip verify) can reproduce this exact
 * item set by passing `{ ...filter, excludeArchived: true }` themselves —
 * see BUG-BACKLOG-RENDER-VERIFY-ARCHIVED-MISMATCH-001.
 */
export async function renderToMarkdown(ctx: BacklogCtx, filter?: BacklogFilter, grammar?: RenderGrammarOptions): Promise<string> {
  const nodes = await queryItemNodes(ctx.store, { ...filter, excludeArchived: true });
  let items = nodes.map(toBacklogItem);
  if (filter?.status === 'open') items = items.filter((it) => !isTerminalStatus(it.status));
  else if (filter?.status === 'closed') items = items.filter((it) => isTerminalStatus(it.status));
  return renderItemsToMarkdown(items, grammar);
}

export async function exportJson(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]> {
  return listItemsNode(ctx.store, filter ?? {});
}

/** Bi-temporal history + supersession chain. */
export async function auditTrail(ctx: BacklogCtx, repo: string, humanId: string): Promise<AuditTrailResult> {
  return auditTrailNode(ctx.store, repo, humanId);
}

/**
 * MIGRATION.md §4.4 — a QUERIED signal, never hardcoded prose: reports the
 * live `migration.phase` config value (`env.ts`, env-overridable via
 * `ADHD_BACKLOG_MIGRATION_PHASE`) plus a human-readable meaning, so an agent
 * (or the `backlog-usage` skill) always asks the tool which of BACKLOG.md or
 * the tool is authoritative right now, instead of trusting a stale doc
 * sentence. NOT yet per-repo-keyed (MIGRATION.md §9 open decision 6) — one
 * global value for the whole machine.
 *
 * The read itself lives in `migration-phase.ts`'s `readBacklogMigrationStatus()`
 * (store-free) so `cli.ts` can short-circuit `backlog migration-status`
 * without opening the store (DEBT-BACKLOG-CLI-STORE-OPEN-001) — this
 * function and that short-circuit share the exact same reading path.
 */
export async function migrationStatus(ctx: BacklogCtx): Promise<MigrationStatusResult> {
  return readBacklogMigrationStatus(ctx.env);
}

/**
 * MIGRATION.md §4.4's "admin CLI call" half: writes `migration.phase`
 * THROUGH to the GLOBAL layer's `config.yaml` (`migration-admin.ts`) so the
 * new value is a durable, cross-process, cross-repo signal — not merely an
 * env var scoped to whoever's shell happened to export it. Whoever executes
 * a phase's Definition of Done calls this exactly once, after verifying the
 * DoD, never speculatively.
 *
 * The write itself lives in `migration-phase.ts`'s `setBacklogMigrationPhase()`
 * (store-free) so `cli.ts` can short-circuit `backlog set-migration-phase`
 * without opening the store (DEBT-BACKLOG-CLI-STORE-OPEN-001) — this
 * function and that short-circuit share the exact same write path.
 */
export async function setMigrationPhase(ctx: BacklogCtx, phase: MigrationPhase): Promise<SetMigrationPhaseResult> {
  return setBacklogMigrationPhase(ctx.env, phase, ctx.adhdRoot);
}

// ============================================================================
// §5.7 — Introspection
// ============================================================================

export interface BacklogVersionInfo {
  /** This package's real `package.json` name, e.g. `"@adhd/backlog"`. */
  name: string;
  /** This package's real `package.json` version — never hardcoded. */
  version: string;
}

/**
 * Reports this running package's own real `name`/`version`, read fresh from
 * `package.json` on every call (never a compiled-in constant, so a
 * republished build can never drift from what this reports). `ctx` is
 * unused — kept for signature consistency with every other `client.ts`
 * export (the `ctx-name-only` invariant every extraction/mount/CLI-dispatch
 * path in this package assumes, per this file's own top-of-file doc
 * comment) rather than special-casing a bare, ctx-less export whose
 * extraction/dispatch behavior has not been verified.
 *
 * The reading itself lives in `version-info.ts`'s `readBacklogVersionInfo()`
 * (store-free) so `cli.ts` can short-circuit `backlog version` without
 * opening the store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001) — this function
 * and that short-circuit share the exact same reading path.
 */
export async function version(ctx: BacklogCtx): Promise<BacklogVersionInfo> {
  // `ctx` deliberately unused (see doc comment above) — the param MUST be
  // named exactly `ctx` for apigen's `ctx-name-only` extraction invariant to
  // exclude it from the generated JSON Schema (confirmed empirically: naming
  // it `_ctx` leaked a `{ _ctx: object }` argument into every transport's
  // schema/CLI-flag/tool listing for this op — extraction only special-cases
  // the literal name `ctx`, not an underscore-prefixed variant). `void ctx`
  // satisfies `@typescript-eslint/no-unused-vars` without renaming the param.
  void ctx;
  return readBacklogVersionInfo();
}
