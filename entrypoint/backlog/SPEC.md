# `@adhd/backlog` — Functional Specification

**Version:** v0.1.0
**Date:** 2026-07-22
**Status:** DESIGN ONLY — no implementation exists yet. This document plus `DESIGN.md` are
the complete contract a subsequent implementer builds from.
**Package:** `entrypoint/backlog/` (nx entrypoint, already scaffolded with a minimal
skeleton — `entrypoint/backlog/{package.json,project.json,src/index.ts}` — see
`DESIGN.md` §7 for the upgrade checklist to the canonical entrypoint shape).

---

## 1. Purpose

`@adhd/backlog` replaces ad-hoc editing of `BACKLOG.md` with a structured, queryable,
multi-agent-safe **graph store** of backlog items (bugs, debt, features, investigations,
plans), while staying compatible with the existing markdown convention this repo already
uses (`BACKLOG.md`, `docs/plan/<plan>/BACKLOG.md`, `packages/**/BACKLOG.md`,
`CHANGELOG.md`).

Today, backlog state lives in flat markdown files parsed ad hoc by
`tools/util/backlog.mjs` (a `stats`/`get`/`list`/`json`/`archive` CLI over a single
file's `##`/`###` headers — `/Users/nix/dev/node/adhd/tools/util/backlog.mjs:1-22`).
That tool is the reference for the status vocabulary and markdown parsing model this
spec is built on (§4, §6) — it is **not** superseded by deleting it in this change; see
`DESIGN.md`'s package-layout section for the migration note.

The problems this tool solves that flat markdown cannot:

1. **No cross-repo view.** `tools/util/backlog.mjs` operates on exactly one file
   (`--file`, default `BACKLOG.md` — `tools/util/backlog.mjs:365`). There is no way to
   ask "show me every open CRITICAL item across the adhd monorepo and the
   sox-ecosystem repos" without hand-aggregating N files.
2. **No safe multi-agent claim.** Two agents editing the same `BACKLOG.md` concurrently
   race on a text file with no compare-and-set; the repo's own plan-orchestration layer
   solved this exact problem for *plans* with a renewable-lease claim protocol (cited in
   §5) — backlog items need the same guarantee.
3. **No structured relationships.** `DEPENDS_ON`/`RELATES_TO`/`SUPERSEDES` exist today
   only as prose ("Cross-links: ..." — e.g. `BACKLOG.md:1069,1078`) with no queryable
   dependency graph, topo order, or cycle detection.
4. **No queryable dedupe.** The dedupe-before-filing rule (global `CLAUDE.md` →
   Disclosure → "Dedupe before filing") is currently manual grep; it should be a real
   FTS + metadata scan the tool runs on every `createItem`.

## 2. Personas

| Persona | Represents | Primary needs |
|---|---|---|
| **Human** | `pseudosky` (or any repo maintainer) via CLI / rendered markdown | Author items, set priority, review spotlight, read rendered `BACKLOG.md`/`CHANGELOG.md`, resolve merges/disputes. |
| **Planner** | An agent authoring/maintaining a `docs/plan/<plan>` corpus | Create items, structure dependencies (`DEPENDS_ON`, `RELATES_TO`, `SUPERSEDES`), attach items to plans, set priority, split/merge items. |
| **Orchestrator** | An agent dispatching work across a DAG or a multi-agent session (conceptually the same role as `dispatch-orchestrator`, `packages/dispatch/dispatch-orchestrator`) | Query ready/blocked work, rollup stats, detect stale claims, assign items. |
| **Implementer** | An agent (or human) doing the actual fix/feature work | Claim an item, transition its status, add citations/notes, resolve to a terminal status. |

Every mutating operation takes an explicit caller identity (`by: string`) — see §5.3.
There is no implicit/ambient identity; a bare role literal (`"agent"`, `"implementer"`)
is explicitly disallowed as an identity value (§5.3), mirroring the plan-state-machine
skill's claim-identity guidance
(`/Users/nix/.claude/plugins/cache/sox-subagents/workflow/0.8.30/skills/plan-state-machine/scripts/state-transition.js:96-107`
`currentActor()` — env var override, else `git config user.name`, never a bare literal).

## 3. Scope model

The tool runs at exactly one of three scopes per process, resolved via `@adhd/environment`
(full wiring in `DESIGN.md` §6):

| Scope | Storage root | Spans |
|---|---|---|
| `global` | `~/.adhd/backlog/<namespace>/data/backlog.db` | **Every repo on the machine** — the one shared graph requirement (#3). |
| `project` | `<projectRoot>/.adhd/backlog/<namespace>/data/backlog.db` | Exactly one repo (the one containing `projectRoot`, detected via a `.git`/`.adhd` marker per `@adhd/environment`'s scope auto-detect — `packages/environment/ARCHITECTURE.md:33-36`). |
| `system` | OS app-support dir (macOS: `~/Library/Application Support/adhd/backlog/<namespace>/data/backlog.db`) | Every repo on the machine (same cross-repo semantics as `global`, different storage root — parity with the generic `@adhd/environment` contract). |

**Resolution order** (highest precedence first): explicit API/CLI `{ scope }` option →
`ADHD_BACKLOG_SCOPE` env var → generic `ADHD_ENV_SCOPE` env var (for parity with other
`@adhd/environment` consumers) → **default `global`**.

This default is a **deliberate override** of `@adhd/environment`'s own generic
auto-detect default (project-marker-found ⇒ `project`,
`packages/environment/ARCHITECTURE.md:33-36`). Requirement #3/#4 (one shared graph
spanning the adhd monorepo, sox-ecosystem, and other repos; cross-repo rollup) means a
silent per-repo split — which is what plain auto-detect gives every tool that runs
inside a git checkout — would defeat the tool's primary purpose. An explicit
`{ scope: 'project' }` remains fully supported for a team that wants a strictly
per-repo backlog instead; it is just not the default.

**Repo identity.** Every item's `repo` field is a stable slug, not an absolute path:
the `owner/name` derived from `git remote get-url origin` when a remote exists (e.g.
`PseudoSky/adhd`, matching the `repository.url` already recorded in
`entrypoint/dispatch-cli/package.json:16-22`), else the repo root directory's basename.
Linked worktrees under `<repo>/.worktrees/*` resolve to the **main** repo's toplevel,
not the worktree's own — mirroring the plan-state-machine skill's `mainRepoRoot()`
handling of exactly this case
(`/Users/nix/.claude/plugins/cache/sox-subagents/workflow/0.8.30/skills/plan-state-machine/scripts/lib/emit-event.js:125-130`) —
so a plan agent working in a worktree files items under the same `repo` id as the main
checkout, not a phantom per-worktree repo.

**Cross-scope aggregation:** not supported in v0.1. A `project`-scoped store and the
`global` store are two entirely separate SQLite files with no sync between them — this
is a real tradeoff, not an oversight (see `DESIGN.md` §9 open questions). A team that
wants the cross-repo rollup (requirement #4) must run in `global` scope, which is why
it is the default.

## 4. Data model

### 4.1 `BacklogItem` (the domain shape every operation reads/returns)

```ts
export type BacklogStatus =
  // open
  | 'OPEN' | 'IN_PROGRESS' | 'PARTIAL' | 'OUTSTANDING' | 'DEFERRED' | 'BLOCKED' | 'MIXED' | 'UNKNOWN'
  // terminal — done
  | 'FIXED' | 'RESOLVED' | 'DONE' | 'SHIPPED' | 'VERIFIED' | 'REMOVED'
  // terminal — workaround
  | 'MITIGATED'
  // terminal — dismissed
  | 'SUPERSEDED' | 'INVALID' | 'DUPLICATE' | 'WONTFIX';

export const TERMINAL_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  'FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED',
  'MITIGATED', 'SUPERSEDED', 'INVALID', 'DUPLICATE', 'WONTFIX',
]);

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Citation {
  /** Repo-relative path, matching the global CLAUDE.md citation format. */
  file: string;
  /** e.g. "42-58"; omit for a whole-file citation. */
  lines?: string;
  /** Free text — active git context / agent name / model, per the citation format. */
  context?: string;
}

export interface Note {
  by: string;
  at: string; // ISO
  text: string;
}

export interface BacklogItem {
  /** The graph node id (see DESIGN.md §2). Never exposed to markdown; internal only. */
  nodeId: number;
  /** Human-facing id, e.g. "BUG-APIGEN-014". Unique within (repo, family). */
  humanId: string;
  /** First hyphen segment of humanId, e.g. "BUG". Open vocabulary — not an enum. */
  kind: string;
  /** humanId with the trailing "-NNN" stripped, e.g. "BUG-APIGEN". */
  family: string;
  title: string;
  /** Markdown body — the full entry text minus the header line. */
  body: string;
  status: BacklogStatus;
  priority?: Priority;
  /** Stable repo slug — see §3 "Repo identity". */
  repo: string;
  /** Package-relative path within the repo, e.g. "packages/apigen/apigen-core-client". Optional — repo-level items omit it. */
  projectPath?: string;
  /** Plan slug this item is attached to, if any — e.g. "agent-registry-schema". */
  plan?: string;
  /** Durable ownership — who this item is assigned to (may differ from the active claimant). */
  assignee?: string;
  /** Ephemeral claim lease — see §5. */
  claimedBy?: string;
  claimedAt?: string; // ISO
  citations: Citation[];
  notes: Note[];
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

### 4.2 Status vocabulary and transition rules

The status set above is exactly the one specified in the task (open: `OPEN`,
`IN_PROGRESS`, `PARTIAL`, `OUTSTANDING`, `DEFERRED`, `BLOCKED`, `MIXED`, `UNKNOWN`;
terminal: `FIXED`, `RESOLVED`, `DONE`, `SHIPPED`, `VERIFIED`, `REMOVED`, `MITIGATED`,
`SUPERSEDED`, `INVALID`, `DUPLICATE`, `WONTFIX`). It is a **superset** of
`tools/util/backlog.mjs`'s existing `STATUS_VOCAB`
(`tools/util/backlog.mjs:40-50`, which uses `IN-PROGRESS` hyphenated and has no
`BLOCKED`/`DUPLICATE`), so importing legacy markdown never fails on an unrecognized
status — see the normalization table in §6.2.

**Rules:**

1. **Every item starts `OPEN`** on `createItem` (no other initial status is settable at
   creation — a planner filing a known-duplicate or known-invalid item still starts
   `OPEN` and immediately calls `transitionStatus` to `DUPLICATE`/`INVALID`, which
   preserves a uniform audit trail: every item has at least one transition event).
2. **Any status may transition to any other status** — this is deliberately *not* a
   strict finite-state-machine graph (unlike the plan-state-machine skill's fixed
   `dag.json` state sequence) because real backlog items regress (`FIXED` → reopened →
   `OPEN`) and get reclassified (`OPEN` → `DUPLICATE`) unpredictably. What IS enforced:
3. **A transition INTO any terminal status requires evidence.** Terminal-done
   (`FIXED`/`RESOLVED`/`DONE`/`SHIPPED`/`VERIFIED`/`REMOVED`) and terminal-workaround
   (`MITIGATED`) transitions require **at least one citation** (either already attached
   via `addCitation` or passed inline to `transitionStatus`/`resolveItem`) — this
   mirrors the global CLAUDE.md rule "No citation, no claim." Terminal-dismissed
   (`SUPERSEDED`/`INVALID`/`DUPLICATE`/`WONTFIX`) transitions require a **reason**
   string instead of a citation (mirroring `memory_invalidate`'s `reason` parameter) —
   a citation is optional but a reason is not.
4. **`claimedBy`/`claimedAt` are cleared on any terminal transition** — an item that
   reaches a terminal status releases its claim automatically (`transitionStatus`
   internally calls the same primitive `releaseClaim` uses, unconditionally, no
   ownership check needed since the transition itself is the authoritative event).
5. **`BLOCKED` is informational, not enforced.** The tool does not prevent
   `startWork`/`claimItem` on a `BLOCKED` item — `blockers(id)` surfaces the blocking
   set for the caller to decide. (`readyItems`, however, only surfaces items whose
   `DEPENDS_ON` set is fully terminal — see §5.2.)

### 4.3 Markdown interoperability contract

Two directions, both required (§8's Definition of Done requires round-tripping):

**`importFromMarkdown(path, repo, projectPath?)`** parses a `BACKLOG.md`-shaped file
using the same algorithm as `tools/util/backlog.mjs`'s `parse()`
(`tools/util/backlog.mjs:106-155`): a `##`/`###` header line matching
`^(#{2,3})\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)` with a digit in the id
(`tools/util/backlog.mjs:34`) opens an item; everything until the next header is its
body. Status is derived the same way — an explicit `**Status:**` field wins
(`tools/util/backlog.mjs:87-89`), else a status word in the header
(`tools/util/backlog.mjs:90-95`) — then **normalized** into the canonical vocabulary of
§4.2 (superset mapping — no legacy status is unrepresentable). Priority is derived the
same way (`tools/util/backlog.mjs:98-104`). Each parsed entry becomes one `createItem`
call with `idOverride` set to the parsed id (so re-importing the same file is
idempotent — see `DESIGN.md` §2.4 dedupe-on-import).

**`renderToMarkdown(filter)`** produces the inverse: one `###` block per item, in the
existing header format (`### {humanId} — {title}`), with a `**Status:**` line and a
`**Citations:**` line matching the format every current `BACKLOG.md` entry already
uses (e.g. `BACKLOG.md:1069` `- Citations: [main, claude, session-2026-07-22-env, ...]`) —
so the OLD `tools/util/backlog.mjs` parser can still read a file this tool rendered,
and a human diffing `git log -- BACKLOG.md` sees no format shock. `archiveResolved`
composes `renderToMarkdown` (scoped to terminal items) with the same block-relocation
semantics as `tools/util/backlog.mjs`'s `archive` command
(`tools/util/backlog.mjs:294-361` — `planArchive`/`buildChangelogSection`), except it
never deletes graph history (only markdown output changes) — see `DESIGN.md` §5.4.

## 5. Operation surface

Every exported function's first parameter is `ctx: BacklogCtx` (the apigen
injection slot — excluded from the generated JSON Schema by the `ctx-name-only`
invariant, `packages/apigen/apigen-core-client/README.md:436`, and reconstructed
per-call via `createClient(envelope)`, `packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:149-155`
— see `DESIGN.md` §6 for how `ctx` is actually built). Signatures below omit `ctx` from
prose descriptions but include it in every code signature for exactness.

### 5.1 CRUD (planner, human)

```ts
export interface DedupeScanInput {
  symbol?: string;
  path?: string;
  errorText?: string;
}

export interface CreateItemInput {
  family: string;                 // e.g. "BUG-APIGEN" — required unless idOverride given
  idOverride?: string;             // explicit human id (import path, or planner-chosen)
  title: string;
  body: string;
  repo: string;
  projectPath?: string;
  priority?: Priority;
  tags?: string[];
  plan?: string;
  /** Source markdown path this item is being imported from, if any (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001). */
  importedFrom?: string;
  dedupeScan?: DedupeScanInput;
  /** Skip the dedupe gate and file anyway (planner override after reviewing candidates). */
  force?: boolean;
}

export interface CreateItemResult {
  item: BacklogItem;
  created: boolean;                // false ⇒ no node written; see duplicateCandidates
  duplicateCandidates: BacklogItem[];
}

/** Dedupe-scans (FTS + symbol/path/errorText metadata match, see DESIGN.md §2.4)
 *  before writing. Allocates humanId as family + next number within (repo, family)
 *  unless idOverride is given. */
export async function createItem(ctx: BacklogCtx, input: CreateItemInput): Promise<CreateItemResult>;

/** repo is required — humanId alone is not globally unique (see §3 "Repo identity"). */
export async function getItem(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem | null>;

export interface UpdateItemInput {
  title?: string;
  body?: string;
  tags?: string[];
  projectPath?: string;
}
export async function updateItem(ctx: BacklogCtx, repo: string, humanId: string, patch: UpdateItemInput): Promise<BacklogItem>;

export interface BacklogFilter {
  repo?: string;
  projectPath?: string;
  status?: BacklogStatus | 'open' | 'closed';
  kind?: string;
  family?: string;
  priority?: Priority;
  plan?: string;
  assignee?: string;
  claimedBy?: string;
  tags?: string[];
  grep?: string;                   // FTS query over title+body
  limit?: number;
  offset?: number;
}
export async function listItems(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]>;

/** Invalidates the node (bi-temporal — never a hard delete; see DESIGN.md §2.3). */
export async function softDeleteItem(ctx: BacklogCtx, repo: string, humanId: string, reason: string): Promise<void>;
```

### 5.2 Query / report (orchestrator, all)

```ts
export interface StatsScope {
  repo?: string;          // absent + global scope ⇒ cross-repo rollup
  projectPath?: string;
}

export interface BacklogStats {
  total: number;
  open: number;
  closed: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  byFamily: Record<string, number>;
  byPriority: Record<string, number>;
  byRepo: Record<string, number>;   // only populated when scope.repo is absent
}
export async function stats(ctx: BacklogCtx, scope?: StatsScope): Promise<BacklogStats>;

/** Open + prioritized, most-severe first — the same "actionable spotlight" tools/util/backlog.mjs prints (tools/util/backlog.mjs:238-246). */
export async function spotlight(ctx: BacklogCtx, scope?: StatsScope, limit?: number): Promise<BacklogItem[]>;

/** Open items whose every DEPENDS_ON target is a terminal status AND which are not currently claimed. */
export async function readyItems(ctx: BacklogCtx, scope?: StatsScope): Promise<BacklogItem[]>;

/** The DEPENDS_ON set of `humanId` that is NOT yet terminal (i.e. what's actually blocking it right now). */
export async function blockers(ctx: BacklogCtx, repo: string, humanId: string): Promise<BacklogItem[]>;

export interface DependencyGraph {
  nodes: Array<{ humanId: string; title: string; status: BacklogStatus }>;
  edges: Array<{ from: string; to: string; rel: 'DEPENDS_ON' | 'RELATES_TO' | 'PART_OF' }>;
}
export async function dependencyGraph(ctx: BacklogCtx, scope?: StatsScope): Promise<DependencyGraph>;

export type TopoOrderResult =
  | { ok: true; order: string[] }             // humanIds, dependency-first
  | { ok: false; cycle: string[] };           // humanIds forming a cycle

export async function topoOrder(ctx: BacklogCtx, scope?: StatsScope): Promise<TopoOrderResult>;

/** Items whose claim lease is older than maxAgeMin with no renewal — candidates for --force reclaim. */
export async function staleClaims(ctx: BacklogCtx, maxAgeMin: number, scope?: StatsScope): Promise<BacklogItem[]>;
```

### 5.3 Multi-agent coordination

Every identity parameter (`by`, `to`) is a caller-supplied string. **It must never be a
bare role literal** (`"agent"`, `"implementer"`, `"orchestrator"`) — two concurrent
agents both claiming as `"implementer"` would appear to be the same claimant and defeat
the CAS protocol entirely. The recommended shape is `${agentName}:${instanceId}` where
`instanceId` is the same per-process token `@adhd/environment` already generates
(`env.instanceId` — pid + short random,
`packages/environment/ARCHITECTURE.md:65` `env.instanceId: string`). See `DESIGN.md`
§4 for the full CAS protocol this implements.

```ts
export interface ClaimOpts {
  /** Minutes after which an unrenewed claim is considered abandoned. Default: see DESIGN.md §4.2. */
  staleAfterMin?: number;
  /** Explicitly override a claim that is NOT stale (human-confirmed abandonment). */
  force?: boolean;
}

export type ClaimStatus = 'claimed' | 'renewed' | 'reclaimed-stale' | 'held';

export interface ClaimResult {
  status: ClaimStatus;
  claimedBy: string;
  claimedAt: string;         // ISO
  /** Only present when status === 'held'. */
  heldBy?: string;
  heldSince?: string;
  /** Only present when status === 'reclaimed-stale' — the abandoned claimant, for audit. */
  previousClaimant?: string;
}

export async function claimItem(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: ClaimOpts): Promise<ClaimResult>;

/** Same-claimant renewal — always succeeds (bumps claimedAt), no contention check, exactly like state-transition.js's claim-renewal branch (state-transition.js:614-623). */
export async function renewClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string): Promise<ClaimResult>;

export interface ReleaseResult {
  status: 'released' | 'release-noop';
  wasClaimedBy?: string;
}
export async function releaseClaim(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: { force?: boolean }): Promise<ReleaseResult>;

/** Durable ownership (planner decision) — distinct from the ephemeral claim lease. See DESIGN.md §2 for why these are two different graph primitives. */
export async function assignItem(ctx: BacklogCtx, repo: string, humanId: string, to: string, by: string): Promise<BacklogItem>;
```

### 5.4 Lifecycle (implementer)

```ts
/** transitionStatus(id, 'IN_PROGRESS', ...) + an implicit claimItem(id, by) — a no-op claim-wise if already held by `by`. */
export async function startWork(ctx: BacklogCtx, repo: string, humanId: string, by: string): Promise<BacklogItem>;

export interface TransitionOpts {
  by: string;
  note?: string;
  citations?: Citation[];    // required (≥1) when status is terminal-done/terminal-workaround — see §4.2 rule 3
  reason?: string;           // required when status is terminal-dismissed — see §4.2 rule 3
}
export async function transitionStatus(ctx: BacklogCtx, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem>;

export async function addCitation(ctx: BacklogCtx, repo: string, humanId: string, citation: Citation): Promise<BacklogItem>;

export async function appendNote(ctx: BacklogCtx, repo: string, humanId: string, by: string, text: string): Promise<BacklogItem>;

/** Sugar for transitionStatus into any terminal status. */
export async function resolveItem(ctx: BacklogCtx, repo: string, humanId: string, status: BacklogStatus, opts: TransitionOpts): Promise<BacklogItem>;

export interface ArchiveOpts {
  /** Exclude specific humanIds from the sweep even though they're terminal (mirrors tools/util/backlog.mjs's --exclude, tools/util/backlog.mjs:311). */
  exclude?: string[];
}
export interface ArchiveResult {
  archivedCount: number;
  changelogMarkdown: string;   // caller (CLI) writes this into CHANGELOG.md
}
/** Renders terminal items to CHANGELOG.md-formatted markdown and marks them archived
 *  (metadata.archivedAt set) so renderToMarkdown's default view excludes them —
 *  the graph node itself is NEVER deleted (bi-temporal history is permanent). */
export async function archiveResolved(ctx: BacklogCtx, scope: StatsScope, opts?: ArchiveOpts): Promise<ArchiveResult>;
```

### 5.5 Structure (planner)

```ts
export async function addDependency(ctx: BacklogCtx, repo: string, humanId: string, dependsOnHumanId: string): Promise<void>;
export async function removeDependency(ctx: BacklogCtx, repo: string, humanId: string, dependsOnHumanId: string): Promise<void>;
export async function linkRelated(ctx: BacklogCtx, repo: string, humanIdA: string, humanIdB: string): Promise<void>;

/** Mints a new item, links new SUPERSEDES old, invalidates old with reason. */
export async function supersedeItem(ctx: BacklogCtx, repo: string, oldHumanId: string, newInput: CreateItemInput, reason: string): Promise<BacklogItem>;

/** Creates N children linked child PART_OF parent. Parent is left open — the caller decides whether/when to resolve it. */
export async function splitItem(ctx: BacklogCtx, repo: string, parentHumanId: string, children: CreateItemInput[]): Promise<BacklogItem[]>;

/** SAME_AS(drop -> keep), invalidates drop with an auto-generated reason. */
export async function mergeItems(ctx: BacklogCtx, repo: string, keepHumanId: string, dropHumanId: string, reason: string): Promise<BacklogItem>;

export async function setPriority(ctx: BacklogCtx, repo: string, humanId: string, priority: Priority): Promise<BacklogItem>;

/** MEMBER_OF edge to a plan node (auto-created if the plan slug hasn't been seen before). */
export async function attachToPlan(ctx: BacklogCtx, repo: string, humanId: string, planSlug: string): Promise<void>;
```

### 5.6 Interop (all)

```ts
export interface ImportMarkdownInput {
  path: string;
  repo: string;
  projectPath?: string;
  /** Plan slug to attach every imported item to (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001) — replaces the post-import attachToPlan-per-id workaround. */
  plan?: string;
  /** Provenance path recorded as each imported node's `importedFrom` field. Defaults to `path` when omitted. */
  sourcePath?: string;
  dryRun?: boolean;
}
/** A `##`/`###` header that failed the strict id pattern but looks like an attempted id — surfaced instead of silently dropped (DEBT-BACKLOG-IMPORT-SILENT-DROP-001). */
export interface MalformedHeaderInfo {
  line: number;
  headerLine: string;
}
export interface ImportResult {
  parsed: number;
  created: number;
  skippedDuplicates: number;
  errors: Array<{ humanId: string; message: string }>;
  malformedHeaders: MalformedHeaderInfo[];
}
export async function importFromMarkdown(ctx: BacklogCtx, input: ImportMarkdownInput): Promise<ImportResult>;

export async function renderToMarkdown(ctx: BacklogCtx, filter?: BacklogFilter): Promise<string>;

export async function exportJson(ctx: BacklogCtx, filter?: BacklogFilter): Promise<BacklogItem[]>;

export interface AuditTrailEntry {
  at: string;
  kind: 'created' | 'transition' | 'claim' | 'note' | 'citation' | 'supersession';
  detail: Record<string, unknown>;
}
export interface AuditTrailResult {
  humanId: string;
  history: AuditTrailEntry[];
  supersessionChain?: { supersedes?: string; supersededBy?: string };
}
/** Bi-temporal history + supersession chain (getSupersessionChain), per DESIGN.md §2.3. */
export async function auditTrail(ctx: BacklogCtx, repo: string, humanId: string): Promise<AuditTrailResult>;
```

## 6. Standardized status vocabulary — normalization table (import compatibility)

Legacy `tools/util/backlog.mjs` label → canonical `BacklogStatus` (identity mappings
omitted):

| Legacy (`tools/util/backlog.mjs:40-50`) | Canonical |
|---|---|
| `IN-PROGRESS` | `IN_PROGRESS` |
| `CLOSED` | `RESOLVED` (generic "closed, no more specific terminal-done label") |
| *(no equivalent)* | `BLOCKED`, `DUPLICATE` are new-only — legacy files never emit them via auto-detection, but a human-written `**Status:** BLOCKED` or `**Status:** DUPLICATE` line already round-trips correctly since `classifyStatus`'s fallback (`tools/util/backlog.mjs:81`) uppercases the first word of any unrecognized status text. |

This mapping is applied once, at `importFromMarkdown` time, so every item in the graph
always carries a canonical `BacklogStatus` — there is no "legacy status" concept
post-import.

## 7. Testing & Definition of Done

Per `AGENTS.md` §7 ("Proving features actually work") — every clause below names a real
entrypoint and observable, not a proxy:

1. **Real-DB CAS claim race.** A test spawns ≥2 concurrent `claimItem` calls (via a
   latch/barrier, not `sleep` — per `AGENTS.md` §7 rule 3) against the **same real
   SQLite file** (two separate `better-sqlite3` connections, not one shared in-process
   object) for the same `humanId`. Assertion: exactly one call returns
   `status:'claimed'`; the other returns `status:'held'`. Revert the `.immediate()`
   transaction wrapper (`DESIGN.md` §4.3) as the negative control and confirm the test
   goes red (both calls succeed, or a `SQLITE_BUSY` crash).
2. **Real markdown round-trip.** `importFromMarkdown` against the repo's actual
   `BACKLOG.md` (or a fixture copy), then `renderToMarkdown` scoped back to the same
   items, then re-run `tools/util/backlog.mjs`'s own `parse()` (imported as a test
   fixture, or the file invoked as a subprocess) against the rendered output. Assertion:
   every original id/status/priority round-trips byte-identically through the OLD
   parser — proves backward compatibility, not just "our own parser can read our own
   output."
3. **Live apigen-mounted server, real HTTP call.** Per `AGENTS.md`'s "Live testing is
   mandatory" — a default-running (unflagged) test builds the entrypoint, mounts it via
   `apiFastifyPlugin.run()` against a real temp SQLite file, and issues a real HTTP
   request (`GET /backlog/client-d/get-item?...` or the safe-op GET path
   `packages/apigen/apigen-core-client/README.md:244`) asserting a real JSON body —
   not a mocked `fns`. (Route is `/backlog/client-d/<kebab-export>`, not
   `/backlog/<exportName>` — see the `client-d` segment note in DESIGN.md §7.)
   A second variant mounts via `mcpPlugin.run()` and drives it as a
   real MCP client (stdio transport) calling the `backlog_client_d_list_items` tool —
   proving the MCP mount path independently of the HTTP path, per this repo's "drive
   the real tools, never a bypass" rule (`AGENTS.md` §7 "Proving an MCP server works").
3b. **Live apigen-mounted CLI, real spawned bin.** The THIRD transport
   (`entrypoint/backlog/src/cli.ts`'s `runBacklogCli`, mounting
   `@adhd/apigen-plugin-cli-output`'s `run()` the same live way): a default-running test
   spawns the REAL BUILT `dist/index.js` as a genuine child process against a
   temp-scoped `.adhd` root (`ADHD_BACKLOG_SCOPE=project` + a throwaway `cwd`) and
   asserts on the process's real exit code + stdout/stderr JSON — never an in-process
   call into `cliPlugin.run()`'s internals. Covers: a bare user command (`get-item
   --repo … --human-id …`, no manual namespace prefix) round-tripping through
   `create-item`, `get-item`, `list-items`; `CLI_EXIT_CODE` on an unknown command (`4`)
   and an unknown flag (`2`); `--help`/no-args printing the live command listing and
   exiting `0`. See `entrypoint/backlog/src/cli.spec.ts`.
4. **Cross-repo scope isolation.** A test constructs two `Environment` instances at
   `project` scope rooted at two different temp directories (each with its own `.git`),
   confirms items created in one are invisible via `listItems` from the other, then
   constructs a third instance at `global` scope and confirms it can see items created
   via **either** project instance are still NOT visible there (project and global are
   separate files, per §3) — proving isolation is real, not accidental.
5. **Dependency cycle detection.** Real `addDependency` calls forming an actual cycle
   (A→B→C→A) against a real store; `topoOrder` must return `{ok:false, cycle:[...]}`
   naming all three ids — not just "does not crash."
6. **Status-vocabulary teeth.** `transitionStatus(..., 'FIXED', { by, note })` with NO
   citations must reject (throw/return an error result) — reverting that guard as the
   negative control must turn this test red.
7. **`nx build backlog` + `nx run backlog:verify-dist-load`** both green — the shipped
   `dist/` entry actually loads and its exports actually run against a real (temp) db,
   not just resolve to source (per `AGENTS.md` §5 "Verify a build actually loads").

## 8. Open questions for the implementer (see `DESIGN.md` §9 for the full list)

- Exact `queryNodes({ metadata: {...} })` matching semantics (equality? nested path?)
  are asserted in the contract summary but not independently verified against
  `@adhd/sox-graph-store`'s real type declarations — verify before relying on it;
  `DESIGN.md` §9 specifies an in-process fallback filter if the assumption is wrong.
- `SUPERSEDES`/`SAME_AS` edge **direction** (new→old vs old→new; keep→drop vs
  drop→keep) is assumed, not confirmed against the real package — `DESIGN.md` §2.3
  states the assumption explicitly.
