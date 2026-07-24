/**
 * client.ts — THE apigen extraction surface (DESIGN.md §5). Mirrors
 * `entrypoint/dispatch-cli/src/api.ts`'s role exactly: plain, JSDoc'd async
 * functions ONLY — no business logic inline, every real wire-up lives in
 * `./store/*`. `ctx: BacklogCtx` is the sole non-serializable parameter,
 * excluded from the generated JSON Schema by the `ctx-name-only` invariant
 * (the FIRST parameter named exactly `ctx`).
 *
 * Every other parameter/return type is plain and JSON-serializable — no
 * class instances, no function-typed parameters (`@adhd/apigen-core-client`'s
 * ts-morph/ts-json-schema-generator extraction requirement).
 */
import type { Environment } from '@adhd/environment';
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
  ImportMarkdownInput,
  ImportResult,
  Priority,
  ReleaseResult,
  StatsScope,
  TopoOrderResult,
  TransitionOpts,
  UpdateItemInput,
} from './model.js';
import { BacklogItemNotFoundError, isTerminalStatus, requiresCitation, requiresReason } from './model.js';
import type { BacklogConfig } from './env.js';
import type { GraphBacklogStore } from './store/graph-backlog-store.js';
import { createItemNode, getItemNode, softDeleteItemNode, updateItemNode } from './store/crud.js';
import { auditTrail as auditTrailNode, blockers as blockersNode, computeStats, dependencyGraph as dependencyGraphNode, listItems as listItemsNode, queryItemNodes, readyItems as readyItemsNode, spotlight as spotlightNode, staleClaims as staleClaimsNode, topoOrder as topoOrderNode } from './store/query.js';
import { toBacklogItem, type BacklogNodeMeta } from './store/mapping.js';
import { claimItemNode, releaseClaimNode, renewClaimNode } from './store/claim.js';
import { addCitationNode, appendNoteNode, archiveTerminalItems, resolveItemNode, startWorkNode, transitionStatusNode } from './store/lifecycle.js';
import { addDependencyNode, assignItemNode, attachToPlanNode, linkRelatedNode, mergeItemsNode, removeDependencyNode, setPriorityNode, splitItemNode, supersedeItemNode } from './store/structure.js';
import { buildChangelogSection, parseBacklogMarkdownWithDiagnostics, renderItemsToMarkdown, toImportItems } from './markdown.js';
import { readFileSync } from 'node:fs';

/** The one type apigen special-cases via the `ctx-name-only` invariant. */
export interface BacklogCtx {
  store: GraphBacklogStore;
  env: Environment<BacklogConfig>;
}

function requireItem(ctx: BacklogCtx, repo: string, humanId: string): BacklogItem {
  const item = getItemNode(ctx.store, repo, humanId);
  if (!item) throw new BacklogItemNotFoundError(repo, humanId);
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

/** repo is required — humanId alone is not globally unique. */
export async function getItem(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem | null> {
  return getItemNode(ctx.store, repo, humanId);
}

export async function updateItem(ctx: BacklogCtx, repo: string, humanId: string, patch: UpdateItemInput): Promise<BacklogItem> {
  return updateItemNode(ctx.store, repo, humanId, patch);
}

export async function listItems(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]> {
  return listItemsNode(ctx.store, filter ?? {});
}

/** Invalidates the node (bi-temporal — never a hard delete). */
export async function softDeleteItem(ctx: BacklogCtx, repo: string, humanId: string, reason: string): Promise<void> {
  softDeleteItemNode(ctx.store, repo, humanId, reason);
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
  const node = requireItem(ctx, repo, humanId);
  return claimItemNode(ctx.store, node.nodeId, by, opts ?? {});
}

/** Same-claimant renewal — always succeeds (bumps claimedAt), no contention check. */
export async function renewClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string): Promise<ClaimResult> {
  const node = requireItem(ctx, repo, humanId);
  return renewClaimNode(ctx.store, node.nodeId, by);
}

export async function releaseClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: { force?: boolean }): Promise<ReleaseResult> {
  const node = requireItem(ctx, repo, humanId);
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
  const archived = archiveTerminalItems(ctx.store, scope, opts ?? {});
  const changelogMarkdown = archived.length > 0 ? buildChangelogSection(archived, new Date().toISOString().slice(0, 10)) : '';
  return { archivedCount: archived.length, changelogMarkdown };
}

// ============================================================================
// §5.5 — Structure
// ============================================================================

export async function addDependency(ctx: BacklogCtx, repo: string, humanId: string, dependsOnHumanId: string): Promise<void> {
  addDependencyNode(ctx.store, repo, humanId, dependsOnHumanId);
}

export async function removeDependency(ctx: BacklogCtx, repo: string, humanId: string, dependsOnHumanId: string): Promise<void> {
  removeDependencyNode(ctx.store, repo, humanId, dependsOnHumanId);
}

export async function linkRelated(ctx: BacklogCtx, repo: string, humanIdA: string, humanIdB: string): Promise<void> {
  linkRelatedNode(ctx.store, repo, humanIdA, humanIdB);
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

/** MEMBER_OF edge to a plan node (auto-created if the plan slug hasn't been seen before). */
export async function attachToPlan(ctx: BacklogCtx, repo: string, humanId: string, planSlug: string): Promise<void> {
  attachToPlanNode(ctx.store, repo, humanId, planSlug);
}

// ============================================================================
// §5.6 — Interop
// ============================================================================

export async function importFromMarkdown(ctx: BacklogCtx, input: ImportMarkdownInput): Promise<ImportResult> {
  const text = readFileSync(input.path, 'utf8');
  const { items: parsed, malformedHeaders } = parseBacklogMarkdownWithDiagnostics(text);
  const items = toImportItems(parsed);
  // Defaults to `path` (the file actually read) — a caller only needs to set
  // `sourcePath` explicitly when importing from a scratch copy but wanting
  // the ORIGINAL path recorded as provenance (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001).
  const sourcePath = input.sourcePath ?? input.path;

  const result: ImportResult = { parsed: items.length, created: 0, skippedDuplicates: 0, errors: [], malformedHeaders };
  if (input.dryRun) return result;

  for (const item of items) {
    try {
      const created = createItemNode(ctx.store, {
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
        attachToPlanNode(ctx.store, input.repo, item.humanId, input.plan);
      }
      if (created.created && item.status !== 'OPEN') {
        // createItem always starts OPEN (SPEC.md §4.2 rule 1) — apply the
        // parsed status as a follow-up transition so import is idempotent
        // AND preserves the source file's real status. Only attach the
        // evidence the status-vocabulary gate actually requires (SPEC.md
        // §4.2 rule 3) — an imported OPEN/IN_PROGRESS/BLOCKED/... item needs
        // neither.
        transitionStatusNode(ctx.store, input.repo, item.humanId, item.status, {
          by: 'system:importFromMarkdown',
          ...(requiresCitation(item.status) ? { citations: [{ file: input.path }] } : {}),
          ...(requiresReason(item.status) ? { reason: `imported from markdown at status ${item.status}` } : {}),
        });
      }
      if (created.created) result.created += 1;
      else result.skippedDuplicates += 1;
    } catch (err) {
      result.errors.push({ humanId: item.humanId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Excludes archived items (SPEC.md §5.4 archiveResolved) — see markdown.ts's renderItemsToMarkdown doc comment. */
export async function renderToMarkdown(ctx: BacklogCtx, filter?: BacklogFilter): Promise<string> {
  const nodes = queryItemNodes(ctx.store, filter ?? {});
  let items = nodes.filter((n) => !(n.metadata as Partial<BacklogNodeMeta> | undefined)?.archivedAt).map(toBacklogItem);
  if (filter?.status === 'open') items = items.filter((it) => !isTerminalStatus(it.status));
  else if (filter?.status === 'closed') items = items.filter((it) => isTerminalStatus(it.status));
  return renderItemsToMarkdown(items);
}

export async function exportJson(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]> {
  return listItemsNode(ctx.store, filter ?? {});
}

/** Bi-temporal history + supersession chain. */
export async function auditTrail(ctx: BacklogCtx, repo: string, humanId: string): Promise<AuditTrailResult> {
  return auditTrailNode(ctx.store, repo, humanId);
}
