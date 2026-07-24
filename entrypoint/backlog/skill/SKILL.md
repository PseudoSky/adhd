---
name: backlog-usage
description: "Use whenever filing, claiming, transitioning, or resolving a backlog item (bug/debt/feature/investigation) in ANY repo on this machine — via the `backlog` CLI/MCP, never by hand-editing a BACKLOG.md file. Also use to check current migration status before assuming markdown vs. the tool is authoritative. Examples: \"log this bug\", \"file a debt item for the flaky test\", \"claim BUG-042\", \"what's still open in this repo\", \"is BACKLOG.md still the source of truth here\"."
---

# `@adhd/backlog` usage

`@adhd/backlog` is a graph-backed, multi-agent, cross-repo backlog tool. It is
migrating every repo on this machine off hand-edited `BACKLOG.md` files onto
itself as the source of truth, with `BACKLOG.md` demoted to a generated,
git-visible *projection* of the graph. This skill is the ONLY place the
command surface, protocol, and migration-state mechanism are documented —
the global `CLAUDE.md`/`AGENTS.md` carry just one pointer line to this file.

## 1. Check migration status FIRST, every time

Never trust a hardcoded phase number in this document — it goes stale the
moment a phase advances. Before deciding whether `BACKLOG.md` or the tool is
authoritative for the CURRENT repo, run:

```
backlog migration-status
```

It reports `{ phase, description, toolIsAuthoritative }`. While
`toolIsAuthoritative` is `false` (phases `not-started`/`phase-1`/`phase-2`),
`BACKLOG.md` (root, per-plan, per-package) is still the real source of truth
in this repo — read/file there by hand as usual, but still prefer `backlog
list-items`/`backlog create-item` for querying and filing so items are
visible cross-repo and get FTS/symbol dedup for free. Once `toolIsAuthoritative`
is `true` (`phase-3` and later), **never hand-edit a `BACKLOG.md` file** —
every one is a generated projection at that point, and a hand-edit will be
silently overwritten (or, once the parity gate is blocking, rejected in CI).

## 2. Command surface — 36 ops, one CLI convention

Every op takes `ctx` as an implicit first argument (never pass it — the CLI/
MCP host supplies it). The CLI's own parameter-naming convention (verified
against real spawned-binary tests, `cli.spec.ts`):

- **Scalar parameters** get individual kebab-case flags, named after the
  parameter itself: `getItem(ctx, repo, humanId)` → `backlog get-item --repo
  <repo> --human-id <id>`.
- **Object-shaped parameters** get a single JSON-blob flag, named after the
  parameter's own name, kebab-cased: `createItem(ctx, input)` → `backlog
  create-item --input '<json>'`.
- The bin name is never part of `argv` — a bare `create-item …`/`get-item …`
  resolves without any manual namespace prefix.
- Failures use real process exit codes (never `0` on error — unknown command
  → exit `4`, bad flag → exit `2`); errors are JSON on the last stderr line.
- Every op is also available as an MCP tool, named `backlog_client_d_<snake_case_op>`
  (e.g. `backlog_client_d_create_item`), once `.mcp.json` wires the server —
  same parameters, same semantics.

| `client.ts` export | CLI form |
|---|---|
| `createItem(ctx, input)` | `backlog create-item --input '<CreateItemInput json>'` |
| `getItem(ctx, repo, humanId)` | `backlog get-item --repo <repo> --human-id <id>` |
| `updateItem(ctx, repo, humanId, patch)` | `backlog update-item --repo <repo> --human-id <id> --patch '<UpdateItemInput json>'` |
| `listItems(ctx, filter?)` | `backlog list-items --filter '<BacklogFilter json>'` |
| `softDeleteItem(ctx, repo, humanId, reason)` | `backlog soft-delete-item --repo <repo> --human-id <id> --reason <text>` |
| `stats(ctx, scope?)` | `backlog stats --scope '<StatsScope json>'` |
| `spotlight(ctx, scope?, limit?)` | `backlog spotlight --scope '<json>' --limit <n>` |
| `readyItems(ctx, scope?)` | `backlog ready-items --scope '<json>'` |
| `blockers(ctx, repo, humanId)` | `backlog blockers --repo <repo> --human-id <id>` |
| `dependencyGraph(ctx, scope?)` | `backlog dependency-graph --scope '<json>'` |
| `topoOrder(ctx, scope?)` | `backlog topo-order --scope '<json>'` |
| `staleClaims(ctx, maxAgeMin, scope?)` | `backlog stale-claims --max-age-min <n> --scope '<json>'` |
| `claimItem(ctx, repo, humanId, by, opts?)` | `backlog claim-item --repo <repo> --human-id <id> --by <identity> --opts '<ClaimOpts json>'` |
| `renewClaim(ctx, repo, humanId, by)` | `backlog renew-claim --repo <repo> --human-id <id> --by <identity>` |
| `releaseClaim(ctx, repo, humanId, by, opts?)` | `backlog release-claim --repo <repo> --human-id <id> --by <identity> --opts '<json>'` |
| `assignItem(ctx, repo, humanId, to, by)` | `backlog assign-item --repo <repo> --human-id <id> --to <identity> --by <identity>` |
| `startWork(ctx, repo, humanId, by)` | `backlog start-work --repo <repo> --human-id <id> --by <identity>` |
| `transitionStatus(ctx, repo, humanId, status, opts)` | `backlog transition-status --repo <repo> --human-id <id> --status <STATUS> --opts '<TransitionOpts json>'` |
| `addCitation(ctx, repo, humanId, citation)` | `backlog add-citation --repo <repo> --human-id <id> --citation '<Citation json>'` |
| `appendNote(ctx, repo, humanId, by, text)` | `backlog append-note --repo <repo> --human-id <id> --by <identity> --text <note>` |
| `resolveItem(ctx, repo, humanId, status, opts)` | `backlog resolve-item --repo <repo> --human-id <id> --status <STATUS> --opts '<json>'` |
| `archiveResolved(ctx, scope, opts?)` | `backlog archive-resolved --scope '<StatsScope json>' --opts '<ArchiveOpts json>'` |
| `addDependency(ctx, repo, humanId, dependsOnHumanId)` | `backlog add-dependency --repo <repo> --human-id <id> --depends-on-human-id <id2>` |
| `removeDependency(ctx, repo, humanId, dependsOnHumanId)` | `backlog remove-dependency --repo <repo> --human-id <id> --depends-on-human-id <id2>` |
| `linkRelated(ctx, repo, humanIdA, humanIdB)` | `backlog link-related --repo <repo> --human-id-a <id1> --human-id-b <id2>` |
| `supersedeItem(ctx, repo, oldHumanId, newInput, reason)` | `backlog supersede-item --repo <repo> --old-human-id <id> --new-input '<CreateItemInput json>' --reason <text>` |
| `splitItem(ctx, repo, parentHumanId, children)` | `backlog split-item --repo <repo> --parent-human-id <id> --children '<CreateItemInput[] json>'` |
| `mergeItems(ctx, repo, keepHumanId, dropHumanId, reason)` | `backlog merge-items --repo <repo> --keep-human-id <id1> --drop-human-id <id2> --reason <text>` |
| `setPriority(ctx, repo, humanId, priority)` | `backlog set-priority --repo <repo> --human-id <id> --priority <PRIORITY>` |
| `attachToPlan(ctx, repo, humanId, planSlug)` | `backlog attach-to-plan --repo <repo> --human-id <id> --plan-slug <slug>` |
| `importFromMarkdown(ctx, input)` | `backlog import-from-markdown --input '<ImportMarkdownInput json>'` |
| `renderToMarkdown(ctx, filter?)` | `backlog render-to-markdown --filter '<BacklogFilter json>'` |
| `exportJson(ctx, filter?)` | `backlog export-json --filter '<json>'` |
| `auditTrail(ctx, repo, humanId)` | `backlog audit-trail --repo <repo> --human-id <id>` |
| `migrationStatus(ctx)` | `backlog migration-status` |
| `setMigrationPhase(ctx, phase)` | `backlog set-migration-phase --phase <PHASE>` (admin-only — only whoever just verified a phase's DoD should call this) |

Every `<repo>` value is this machine's stable git-remote-derived slug (e.g.
`PseudoSky/adhd`) — never a bare directory name. A worktree agent
(`<repo>/.worktrees/*`) resolves to the SAME main-repo `repo` slug, not a
phantom per-worktree repo.

## 3. Claim/renew/release protocol (multi-agent use)

- Identity is always `${agentName}:${instanceId}` — NEVER a bare role literal
  like `"agent"`. Two concurrent agents both claiming as `"implementer"`
  defeats the CAS protocol entirely.
- `claimItem` is idempotent for the SAME claimant — always `renewed`, no
  contention check.
- A long-running task must call `renewClaim` periodically (default
  staleness: 30 minutes).
- Every exit path (done/error/abandoned) calls `releaseClaim`
  unconditionally — it is a no-op on an already-unclaimed item, never an
  error. Never leave an item claimed after you stop working on it.

## 4. Citations — via tool calls, never hand-typed markdown

The `Citation` type (`{ file, lines?, context? }`) is the structured form of
one bracketed citation entry in the old hand-edited convention. Instead of
typing a `Citations: [...]` line by hand:

- Call `transitionStatus`/`resolveItem` with `{ citations: [...] }` when
  moving into any terminal-done/terminal-workaround status — this is
  REQUIRED and enforced (a status transition without citations there is
  rejected).
- Call `addCitation` to attach evidence without a status change.

## 5. Dedupe before filing — via the tool, not eyeballing

`createItem` runs a dedupe scan (FTS over title+body, plus exact
symbol/path/errorText metadata match) BEFORE writing, and returns
`duplicateCandidates` alongside `created: false` when a likely match exists.
**Always inspect `duplicateCandidates` first.** Only pass `force: true` after
confirming the candidates are genuinely a distinct issue — never as a way to
skip reading them.

## 6. Filing a new item — worked example

```
backlog create-item --input '{
  "family": "BUG-MYAREA",
  "title": "Short, specific summary",
  "body": "Full description, root cause if known, evidence.",
  "repo": "PseudoSky/adhd",
  "projectPath": "packages/domain/my-package",
  "priority": "HIGH"
}'
```

If the response has `created: false` with non-empty `duplicateCandidates`,
read them before deciding whether to `force: true` or update the existing
item instead (`updateItem`/`appendNote`).
