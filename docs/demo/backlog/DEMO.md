# 🎬 Backlog Interface v2 — Target-State Demo & Acceptance Script

> Six verbs. Every repo. Every question. One call to resume where you left off.

**What this is.** A presentation-grade walkthrough of the backlog CLI's redesigned
surface — the 38-command flat surface collapsed into six verbs (`get`, `query`, `create`,
`update`, `relate`, `admin`), served identically to CLI, MCP, REST, and OpenAPI. Follow
it top to bottom and you will (a) experience the product the way a brand-new operator
would and (b) prove every capability against the acceptance criteria (AC-0..AC-31), with
exact commands, exact data, and pass/fail checks. It is the contract for what "done"
means: if it's demonstrated here, it must work; if it must work, it's demonstrated here.

**Target-state framing.** The implementation is underway in parallel (plan
`backlog-interface-v2-dispatch`, work order C-13). Every step is tagged
**target-state (gates AC-NN)** when the capability is not shipped yet, versus
**shipped today (v1 …)** when it describes current v1 behavior. Nothing in this demo is
presented as live except where explicitly marked shipped.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. |
| ▶️ **Do** | The exact action to take, with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (IDs, tokens, timestamps) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Acceptance-criteria IDs this beat satisfies (AC-0..AC-31, INTERFACE_v2 §10). |
| 📎 **Source** | What grounds this step — spec § / AC / file. ⟦U#⟧ tags mark guessed interfaces, logged in `UNRESOLVED.md`. |
| ⟦U#⟧ | An unresolved stub: an interface guessed because the context didn't specify it. Never inside a runnable command or JSON literal — only on Source lines. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |
| **Status** | `target-state (gates AC-NN)` vs `shipped today (v1 …)` — which world this step describes. |

**Conventions**

- Shell prompt is `$`; commands are run from the repo root unless noted.
- `backlog` is the built CLI binary (`npx nx build backlog` first, §2.4). All CLI commands
  in this script are target-state unless tagged shipped.
- Every CLI response is the envelope `{ ok: boolean, data?, error?: { code, message,
  details? }, warnings?: string[] }` (INTERFACE_v2 §7.1). Exit codes: `0` success, `1`
  single-item not-found, `2` bad flag / validation, `4` unknown command (§7.2).
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays
  invariant. Timestamps are UTC ISO-8601.
- All sample data is fictional (`fixtures/backlog-demo.md`), seeded into a throwaway store
  at `tmp/backlog-demo` (§2.4).
- Every ungrounded interface is tagged ⟦U#⟧ on the step's Source line and logged in
  `UNRESOLVED.md` — confirm those before treating the step as authoritative.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Maya Reyes runs agent-assisted triage for a two-repo org. Yesterday her
planning session died mid-flight: her agent had half-filed a bug, claimed a work item,
transitioned another to DONE — and the 38-command backlog CLI buried the state she needed
under a wall of flat commands nobody can keep in their head. The redesign she's here to
see collapses that surface to six verbs, makes every read return a terse card instead of
a 90 KB body dump, and — the part she can't quite believe — lets a dead session resume
from **one call**.

> **The promise we'll prove in the next ~40 minutes:** six verbs replace thirty-eight;
> a natural-language query finds the right items across every repo without you naming one;
> filing a duplicate is caught before it happens; and a killed session resumes from a
> single tool call with no hand-written ledger.

🔗 **Proves (framing):** AC-0 · AC-5 · AC-16 · AC-27
📎 **Source:** INTERFACE_v2 §0 design principles 1–3, §2.1b, §5a.6; work order C-13 section list

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Maya Reyes

Maya is a **product manager and agent operator** for a small platform org: the `adhd`
monorepo and the `sox-ecosystem` repo, plus two small fork-scale repos that share a bare
name (`agent-tools/embedding-server` and `sox/embedding-server` — the ambiguity trap
comes back in Act 2). She files bugs, plans work, and dispatches agents that claim items
and report back. Her concrete goal today: resume a killed planning session on plan
PLAN-001, file two new bugs correctly, and prove to her lead that the new surface is
trustworthy — including when it refuses her.

**Also appearing:** the flat-surface ghost — the v1 38-command CLI she's un-learning, and
the two `researcher:*` agent instances (a1b2c3, x9y8z7) whose filings must aggregate into
one author bucket.

### 2.2 The Canonical Demo Dataset

Seeded into `tmp/backlog-demo` (store) from `fixtures/backlog-demo.md` (§2.4). This is
the single source of data truth — every later beat refers back to these rows. Dimension
nodes per GRAPH_MODEL_v2: repos, projects (`core-platform` ← adhd, `sox-platform` ←
sox-ecosystem), packages (`<repo>::<projectPath>`), identities (canonical keys).

| humanId | kind | title | status | priority | repo (canonical) | projectPath | author → reporter | plan | dupeHits | DEPENDS_ON |
|---|---|---|---|---|---|---|---|---|---|---|
| PLAN-001 | EPIC | Interface v2 rollout | OPEN | HIGH | adhd | — | researcher → researcher | — | 0 | — |
| BUG-1 | BUG | nx build fails after fastify bump | IN_PROGRESS | HIGH | adhd | packages/workspace | researcher:a1b2c3 → researcher:a1b2c3 | PLAN-001 | 0 | FEAT-1 |
| BUG-2 | BUG | sign-in button unresponsive on rate-limit page | OPEN | HIGH | adhd | packages/ui-react | researcher:x9y8z7 → researcher:x9y8z7 | — | 2 | — |
| BUG-3 | BUG | storybook mcp bridge times out | OPEN | MEDIUM | adhd (alias `PseudoSky/adhd`) | packages/ui-react | ops → ops | — | 0 | — |
| BUG-8 | BUG | auth flow hangs under throttled requests | OPEN | MEDIUM | adhd | packages/ui-react | researcher → researcher | — | 0 | — |
| FEAT-1 | FEAT | apigen java javalin plugin slice 2/3 | OPEN | MEDIUM | adhd | packages/apigen/apigen-plugin-java-javalin | researcher:a1b2c3 → researcher:a1b2c3 | PLAN-001 | 0 | BUG-4 |
| TASK-1 | TASK | document 6-tool surface in SKILL.md | DONE | LOW | adhd | entrypoint/backlog | researcher → researcher | PLAN-001 | 0 | — |
| TASK-2 | TASK | shell completion for enum flags | OPEN | LOW | adhd | entrypoint/backlog | researcher → researcher | PLAN-001 | 0 | — |
| BUG-4 | BUG | embedding server OOM on batch | OPEN | HIGH | sox-ecosystem | extensions/bundles/sox-embedding-bundle | researcher:x9y8z7 → researcher:x9y8z7 | — | 0 | BUG-5 |
| BUG-5 | BUG | turso adapter offset ignored | OPEN | HIGH | sox-ecosystem | packages/sox-store-adapter | researcher → researcher | — | 0 | — |
| BUG-6 | BUG | memory server crash on embed batch | OPEN | MEDIUM | sox-ecosystem | packages/sox-memory-core | anna → anna | — | 0 | — |
| BUG-9 | BUG | sign-in button unresponsive on rate-limit page (dupe of BUG-2) | OPEN | MEDIUM | sox-ecosystem | extensions/bundles/sox-web-console | researcher → researcher | — | 0 | — |
| FEAT-2 | FEAT | port apigen host to memory-server | OPEN | MEDIUM | sox-ecosystem | packages/sox-memory-core | researcher → researcher | — | 0 | — |

Field notes grounded in the specs: `family` is derived from the humanId prefix
(GRAPH_MODEL_v2 §2.3); `files[]` is the optional FEAT-005 Stage-3 field (§5a.3); the
`researcher:a1b2c3` / `researcher:x9y8z7` spellings are claim-instance identities whose
author/reporter **canonicalizes to `researcher`** (§2.1.1 — AC-14's stability contract).

### 2.3 Prerequisites

- Node.js 20+ and `corepack` (for `corepack yarn install`).
- The repo checked out at a commit that builds `backlog` (the demo targets the state
  where the 6-tool surface ships; the build must at least produce the current binary so
  `serve` and the v1 commands it contrasts against exist).
- A running sox embedding service for the semantic steps, OR the fallback path each
  semantic step declares (AC-12: `rag_not_configured` degrade) — steps that need real
  embeddings say so and are tagged accordingly.
- `jq` for the JSON assertions (or an equivalent JSON filter).
- Nothing else: the demo store, fixtures, and server are created by the script itself.

### 2.4 Cold Start — From Nothing to Running

🎬 **Scene.** Maya's first encounter: install, build, prove the artifact loads, seed the
demo store, and see the new surface for the first time.

▶️ **Do**
```bash
$ corepack yarn install
$ npx nx build backlog
$ npx nx run backlog:verify-dist-load
$ backlog admin --action import --store tmp/backlog-demo --file docs/demo/backlog/fixtures/backlog-demo.md
```

👀 **Expect**
```
$ corepack yarn install
  ➤ YN0000: ─ Done in 8.42s
$ npx nx build backlog
  ✔ nx run backlog:build  (8s)
$ npx nx run backlog:verify-dist-load
  ✔ nx run backlog:verify-dist-load  (1s)
  dist/entry.js loaded and served 6 operations
$ backlog admin --action import --store tmp/backlog-demo --file docs/demo/backlog/fixtures/backlog-demo.md
{ ok: true, data: { imported: 13, skipped: 0, errors: [] } }
```

✅ **Verify**
- [ ] `nx build backlog` exits 0.
- [ ] `verify-dist-load` loads the **real `dist/` entry** (not source) and exits 0 — the
      shipped artifact actually boots.
- [ ] The import reports `imported: 13` (12 items + 1 plan) and `errors: []`.

🔗 **Proves:** AC-21 (real artifact, real seam) · AC-0 (the loaded surface reports 6
operations)
📎 **Source:** INTERFACE_v2 §10.8 AC-21, §6 (admin `import` action absorbs
import-from-markdown); AGENTS.md §5 verify-dist-load; repo §10 tmp/ convention. ⟦U12⟧
import fixture syntax (the v2 markdown import format is not pinned in the spec) and
⟦U13⟧ the `--store` store-path flag spelling — see UNRESOLVED.md

---

## 3 · The Journey

### Act 1 — Onboarding: Meet the Six Verbs

*Maya's first minute with the new surface: what exists, what refused to exist, and how
the same six verbs reach every transport.*

#### 1.1 · The whole surface fits on one screen   (happy)

🎬 **Scene.** Maya runs `backlog --help`. Her test: can she hold the entire data surface
in her head? Six verbs — and the two host commands that stay outside the surface must
not be hiding inside it.

**Status: target-state (gates AC-0)**

▶️ **Do**
```bash
$ backlog --help
```

👀 **Expect**
```
backlog — 6 data verbs, one envelope, four transports (CLI / MCP / REST / OpenAPI)

  backlog get    <--human-id> [--fields ...]     one item, deep context on demand
  backlog query  [view|flags|positional text]     the query layer (10 views)
  backlog create [input...]                       instantiate + filing-time interception
  backlog update <--human-id> [patch|status|...]  all mutations, outcome-reporting
  backlog relate <--source-id> <--target-id>      graph edges (dependency/related/plan)
  backlog admin  <--action ...>                   bulk, maintenance, system

  host commands (not data ops, deliberately outside the six):
  install | install-skill | serve

  run "backlog <verb> --help" for per-verb flags.
```

✅ **Verify**
- [ ] The help lists **exactly** the six verbs: `get`, `query`, `create`, `update`,
      `relate`, `admin`.
- [ ] `install`, `install-skill`, and `serve` appear **outside** the six, labelled as host
      commands — the carve-out is pinned, not accidental (negative assertion).
- [ ] `backlog --help` exits 0 **without opening the store** (lazy context — the v1
      resolution, kept as a regression guard).

🔗 **Proves:** AC-0 (one operation set, six verbs, host carve-out)
📎 **Source:** INTERFACE_v2 §6 carve-out (verified cli.ts:243-265), §10.0 AC-0;
DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 (resolved in v1, retained as regression AC).
⟦U3⟧ exact help layout inferred — see UNRESOLVED.md

#### 1.2 · NEGATIVE CONTROL — the old flat surface is refused   (edge)

🎬 **Scene.** Muscle memory. Maya types the v1 command she's used for months. The new
surface must make the mistake obvious, not silent.

**Status: target-state (gates AC-5).** *Shipped today contrast: `backlog list-items` is a
live v1 command on the 38-command surface. This demo documents the target state in which
it is rejected — proving the 6-verb surface is the *only* surface.*

▶️ **Do**
```bash
$ backlog list-items --repo adhd
$ echo $?
```

👀 **Expect**
```
{ ok: false, error: { code: "not_found", message: "unknown command 'list-items' — the flat surface is gone; use 'backlog query --view list' (INTERFACE_v2 §7.9)" } }
$ echo $?
4
```

✅ **Verify**
- [ ] Exit code is **4** (`not_found`, unknown command) — not 0, not 2.
- [ ] The error message names the replacement (`backlog query`), so the operator is
      pointed forward, not stranded.
- [ ] Nothing was executed and no state changed (this is a refusal, not a fallback).

🔗 **Proves:** AC-5 (verb collapse — flat names rejected with a pointer) · AC-6 (exit 4)
📎 **Source:** INTERFACE_v2 §10.2 AC-5, §7.2 exit codes, §7.9 (flat-name migration is
enumerated, SKILL.md ships the 6-tool surface first)

#### 1.3 · Six verbs over HTTP: `backlog serve --transport http`   (happy)

🎬 **Scene.** CLI is one seam. Maya wants the same surface reachable by the web
dashboard and by scripts. The pinned mount root: `GET /` lists what's served.

**Status: target-state (gates AC-1)**

▶️ **Do**
```bash
$ backlog serve --transport http --port 8787 &
$ sleep 1
$ curl -s http://127.0.0.1:8787/
$ curl -s -X POST http://127.0.0.1:8787/get -H 'content-type: application/json' \
    -d '{"humanId":"BUG-1"}'
```

👀 **Expect**
```
$ curl -s http://127.0.0.1:8787/
{ ok: true, data: { operations: ["get", "query", "create", "update", "relate", "admin"], mount: "/", transport: "http" } }

$ curl -s -X POST http://127.0.0.1:8787/get -H 'content-type: application/json' -d '{"humanId":"BUG-1"}'
{ ok: true, data: { humanId: "BUG-1", kind: "BUG", title: "nx build fails after fastify bump", status: "IN_PROGRESS", priority: "HIGH", projectPath: "packages/workspace", updatedAt: "⟨ts⟩" } }
```

✅ **Verify**
- [ ] `GET /` lists **all six** verbs and nothing else (one spelling — the mount root is
      pinned, not "or").
- [ ] A representative route per verb family responds in the `{ ok, data?, error? }`
      envelope (the `/get` call above is one; `query`/`create`/`update`/`relate`/`admin`
      are exercised in later acts over the same transport).
- [ ] The `backlog get` card carries exactly `humanId, kind, title, status, priority,
      projectPath, updatedAt` (§1 — the single-item affordance adds projectPath/updatedAt).

🔗 **Proves:** AC-1 (serve http; GET / lists operations; envelope over HTTP)
📎 **Source:** INTERFACE_v2 §10.1 AC-1, §1 default card shape. ⟦U4⟧ GET / body shape
(operations array spelling) inferred — see UNRESOLVED.md

#### 1.4 · The OpenAPI document is derived, not hand-written   (happy)

🎬 **Scene.** Maya's lead wants a machine-readable contract. The OpenAPI document must
come from the same operation descriptors the CLI and MCP serve — never a hand-maintained
spec that drifts.

**Status: target-state (gates AC-2)**

▶️ **Do**
```bash
$ curl -s http://127.0.0.1:8787/meta/openapi | jq -e '.openapi == "3.1.0"' && echo "version ok"
$ curl -s http://127.0.0.1:8787/meta/openapi | jq -r '.paths | keys[]' | sort
```

👀 **Expect**
```
version ok
/get
/query
/create
/update
/relate
/admin
```

✅ **Verify**
- [ ] `.openapi == "3.1.0"` (jq -e exits 0).
- [ ] The `paths` keys cover **every served operation** — all six verbs appear.
- [ ] The document is derived from the operation descriptors (same source as the CLI
      help and MCP tools/list — no hand-written spec; a conformant OpenAPI validator
      accepts the document).

🔗 **Proves:** AC-2 (OpenAPI 3.1 at /meta/openapi, paths cover every operation)
📎 **Source:** INTERFACE_v2 §10.1 AC-2, §10.0 AC-0 (one package → four mounts).
⟦U5⟧ path spellings under /meta/openapi inferred from the plugin's stripping convention —
see UNRESOLVED.md

#### 1.5 · Both transports at once; the MCP default is unchanged   (happy)

🎬 **Scene.** Maya wants HTTP *and* MCP live simultaneously for the dashboard and her
agents — and needs assurance the default MCP behavior agents already depend on did not
change.

**Status: target-state (gates AC-3, AC-4).** `serve --transport mcp` is shipped today;
`--transport both` is target-state.

▶️ **Do**
```bash
$ backlog serve --transport both --port 8788 &
$ curl -s http://127.0.0.1:8788/ | jq -r '.data.operations[]' | sort
$ printf '%s' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
    backlog serve --transport mcp --port 8789 2>/dev/null | jq -r '.result.tools[].name'
```

👀 **Expect**
```
get
query
create
update
relate
admin
get
query
create
update
relate
admin
```

✅ **Verify**
- [ ] With `--transport both`, the HTTP route table and the MCP `tools/list` each expose
      the **same six verbs**, independently.
- [ ] `--transport mcp` (default) still speaks MCP over stdio exactly as today — the
      default behavior is unchanged.

🔗 **Proves:** AC-3 (both transports simultaneously) · AC-4 (mcp default unchanged)
📎 **Source:** INTERFACE_v2 §10.1 AC-3, AC-4

---

### Act 2 — Dimensional Queries: Every Dimension, One SQL

*Maya needs "bugs for X repo by Z author" to be one correct call — never a JS post-filter
that silently truncates. Act 2 is where the dimensional model earns its keep.*

#### 2.1 · One repo, one query, fork keys reconciled   (happy)

🎬 **Scene.** BUG-3 was filed under the fork spelling `PseudoSky/adhd`. Maya expects the
canonical repo node to absorb it — one query, no footnotes.

**Status: target-state (gates AC-7, AC-25)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"repo":"adhd"}' --limit 5 --fields humanId,kind,title,status,priority
```

👀 **Expect**
```
{ ok: true, data: {
    items: [
      { humanId: "PLAN-001", kind: "EPIC", title: "Interface v2 rollout", status: "OPEN", priority: "HIGH" },
      { humanId: "BUG-1",    kind: "BUG",  title: "nx build fails after fastify bump", status: "IN_PROGRESS", priority: "HIGH" },
      { humanId: "BUG-2",    kind: "BUG",  title: "sign-in button unresponsive on rate-limit page", status: "OPEN", priority: "HIGH" },
      { humanId: "BUG-3",    kind: "BUG",  title: "storybook mcp bridge times out", status: "OPEN", priority: "MEDIUM" },
      { humanId: "BUG-8",    kind: "BUG",  title: "auth flow hangs under throttled requests", status: "OPEN", priority: "MEDIUM" }
    ],
    total: 8, returned: 5
  } }
```

✅ **Verify**
- [ ] Every item's canonical repo is `adhd`; **BUG-3 — filed under the alias
      `PseudoSky/adhd` — is present** (fork-key reconciliation, GRAPH_MODEL §3).
- [ ] No foreign-repo item appears (`sox-ecosystem` items absent).
- [ ] `total: 8` (all adhd items), `returned: 5` (the limit) — the `{ total, returned }`
      contract is present in the envelope, not assumed.

🔗 **Proves:** AC-7 (single-repo filter incl. alias-filed items) · AC-25 ({ total,
returned } pinned)
📎 **Source:** INTERFACE_v2 §10.3 AC-7, §10.9 AC-25; GRAPH_MODEL_v2 §3 (canonicalRepoKey,
alias map)

#### 2.2 · Flag sugar: one grammar, two spellings   (happy)

🎬 **Scene.** Maya refuses to quote JSON in a shell for the 80% case. The flag forms must
compile into the filter — and be provably identical.

**Status: target-state (gates AC-22)**

▶️ **Do**
```bash
$ backlog query --repo adhd --author researcher --status open --kind BUG --fields humanId,title
$ backlog query --view list --filter '{"repo":"adhd","author":"researcher","status":"open","kind":"BUG"}' --fields humanId,title
$ backlog query --view list --repo adhd --since 3d --fields humanId,title,updatedAt
```

👀 **Expect**
```
{ ok: true, data: { items: [ { humanId: "BUG-1", ... }, { humanId: "BUG-2", ... } ], total: 2, returned: 2 } }
{ ok: true, data: { items: [ { humanId: "BUG-1", ... }, { humanId: "BUG-2", ... } ], total: 2, returned: 2 } }
{ ok: true, data: { items: [ { humanId: "BUG-1", title: "nx build fails after fastify bump", updatedAt: "2026-08-06T09:12:00Z" }, { humanId: "BUG-4", title: "embedding server OOM on batch", updatedAt: "2026-08-07T15:40:00Z" } ], total: 2, returned: 2 } }
```

✅ **Verify**
- [ ] The flag-spelling and JSON-spelling results are **byte-identical** (same two items:
      BUG-1, BUG-2 — BUG-3's author is `ops`, TASK-2's kind is TASK, so both drop).
- [ ] `--since 3d` compiles to `filter.dateRange.updated.since` server-side and returns
      exactly the items updated since 2026-08-05 (BUG-1, BUG-4) — TASK-2 (updated
      2026-07-30) is excluded, proving the boundary is honored, not ignored.
- [ ] An unknown flag or unknown filter key is a `validation`/`invalid_argument` error
      (exit 2), never a silent no-op (see §5.1/§5.2).

🔗 **Proves:** AC-22 (flag sugar == JSON filter; --since natural-language dates)
📎 **Source:** INTERFACE_v2 §2.1a, §10.9 AC-22

#### 2.3 · Cross-repo: one graph, two repos   (happy)

🎬 **Scene.** Maya's adhd work item FEAT-1 (apigen javalin plugin) depends on BUG-4 in
`sox-ecosystem`. A repo-scoped graph query must surface the cross-repo edge.

**Status: target-state (gates AC-8)**

▶️ **Do**
```bash
$ backlog query --view graph --filter '{"repo":"adhd"}' --fields humanId,title
$ backlog query --view graph --filter '{"repo":"sox-ecosystem"}' --group-by project --fields humanId,title
```

👀 **Expect**
```
{ ok: true, data: { edges: [
    { from: "FEAT-1", to: "BUG-4", rel: "dependency" },
    { from: "BUG-1",  to: "FEAT-1", rel: "dependency" }
  ], nodes: ⟨8 adhd nodes⟩ } }

{ ok: true, data: { projects: [ { project: "core-platform", reason: "depends on this repo via FEAT-1 -> BUG-4" } ] } }
```

✅ **Verify**
- [ ] The adhd-scoped graph surfaces **FEAT-1 → BUG-4** — an item-level `DEPENDS_ON` edge
      into `sox-ecosystem`, visible from a repo-scoped query (cross-repo dependency).
- [ ] The project-level traversal — "which projects depend on repo `sox-ecosystem`" —
      returns `core-platform` (the project of the *dependent* repo adhd, via
      `PROJECT_OF`).

🔗 **Proves:** AC-8 (cross-repo dependency surfaced; project-level traversal)
📎 **Source:** INTERFACE_v2 §10.3 AC-8; GRAPH_MODEL_v2 §2.2 (DEPENDS_ON item-level,
PROJECT_OF repo→project). ⟦U1⟧ project-level traversal invocation/shape (EPIC-A
aggregateBy not pinned in the spec) — see UNRESOLVED.md

#### 2.4 · Ambiguity is never silent   (⚠️ edge)

🎬 **Scene.** Two genuinely different repos share the bare name `embedding-server`. Maya
types the bare name. The surface must not quietly pick one.

**Status: target-state (gates AC-24, AC-6 empty list)**

▶️ **Do**
```bash
$ backlog query --view list --repo embedding-server
$ echo $?
```

👀 **Expect**
```
{ ok: true, data: { items: [], total: 0 },
  warnings: [ "bare repo name 'embedding-server' matches agent-tools/embedding-server and sox/embedding-server; resolved to agent-tools/embedding-server" ] }
$ echo $?
0
```

✅ **Verify**
- [ ] `ok: true` (a successful read) **plus a `warnings` entry naming the ambiguity and
      the chosen node** — never a silent narrow.
- [ ] An empty list result is `ok: true, data: []`, **exit 0** — a list is never
      "not found".
- [ ] No error code was raised: ambiguity surfaced as a warning, not a failure.

🔗 **Proves:** AC-24 (ambiguity warning) · AC-6 (empty list: ok:true, data:[], exit 0)
📎 **Source:** INTERFACE_v2 §10.9 AC-24, §7.1 warnings, §7.2 exit codes; GRAPH_MODEL_v2 §3
(ambiguity surfaced on query path)

---

### Act 3 — The Natural-Language Query

*The flagship. "Show me what's relevant" without naming a repo, a kind, or a filter. The
whole string is the semantic query; the planner refines, never narrows.*

#### 3.1 · "nx bugs and apigen" — semantic-first, cross-repo   (happy, the wow)

🎬 **Scene.** Maya doesn't know which repo holds what. She types the sentence. The full
string must go to the semantic matcher, unscoped by default; the envelope must show her
exactly what the string became.

**Status: target-state (gates AC-27). Depends on the embedding service (sox embedding
bundle via the `embedding-remote` plugin); without it, the whole string falls back to FTS
and still works (§5.4).**

▶️ **Do**
```bash
$ backlog query "nx bugs and apigen" --fields humanId,kind,title,_score
```

👀 **Expect**
```
{ ok: true, data: {
    items: [
      { humanId: "FEAT-1", kind: "FEAT", title: "apigen java javalin plugin slice 2/3", _score: 0.89 },
      { humanId: "BUG-1",  kind: "BUG",  title: "nx build fails after fastify bump",    _score: 0.84 },
      { humanId: "FEAT-2", kind: "FEAT", title: "port apigen host to memory-server",    _score: 0.77 }
    ],
    total: 3, returned: 3,
    query: {
      semantic: "nx bugs and apigen",
      filter: {},
      boosts: [ { term: "apigen", type: "package", confidence: 0.87, applied: "boost" } ],
      sort: "relevance",
      extracted: [
        { term: "apigen", type: "package",  confidence: 0.87, applied: "boost" },
        { term: "nx",     type: "keyword",  confidence: 0.62, applied: "boost" },
        { term: "bugs",   type: "kind",     confidence: 0.91, applied: "boost" }
      ]
    }
  } }
```

✅ **Verify**
- [ ] `data.query.semantic` is the **entire string** — "nx bugs and apigen" — nothing
      subtracted, no remainder.
- [ ] `filter: {}` — extraction **never narrowed the recall**: no implicit repo/kind
      filter was applied.
- [ ] **Cross-repo recall:** FEAT-2 (an item about apigen *hosting* in `sox-ecosystem`)
      ranks even though the extracted term "apigen" is a package in the adhd repo.
- [ ] **Paraphrase recall:** BUG-1 (title "nx build fails…", no word "bug") ranks #2 via
      the semantic channel.
- [ ] Every extraction is surfaced in `extracted` as a **boost** — visible, never silent.

🔗 **Proves:** AC-27 (semantic-first, unscoped, planner-as-boost, transparent
data.query)
📎 **Source:** INTERFACE_v2 §2.1b, §10.10 AC-27 (the envelope literal is the AC's own
shape); RAG-SPEC §3.1 (semanticSearch is the primary channel)

#### 3.2 · The only way to scope is to say so   (happy)

🎬 **Scene.** Maya wants just the adhd side. Explicit flags are the *only* filters — and
the other-repo item must drop.

**Status: target-state (gates AC-27c)**

▶️ **Do**
```bash
$ backlog query "nx bugs and apigen" --repo adhd --fields humanId,kind,title
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "FEAT-1", kind: "FEAT", title: "apigen java javalin plugin slice 2/3" },
    { humanId: "BUG-1",  kind: "BUG",  title: "nx build fails after fastify bump" }
  ], total: 2, returned: 2 } }
```

✅ **Verify**
- [ ] FEAT-2 (`sox-ecosystem`) **drops** when `--repo adhd` is explicit.
- [ ] The remaining two items are exactly the adhd-relevant ones — scoping narrows,
      extraction never did.

🔗 **Proves:** AC-27 (explicit --repo scopes the same query; the other-repo item drops)
📎 **Source:** INTERFACE_v2 §2.1b item 2, §10.10 AC-27(b)(c)

#### 3.3 · Parity: the refined form is reproducible   (happy)

🎬 **Scene.** The refined result of the NL query must be re-derivable as an explicit
`view:list` + filter + semantic call — same items, so an agent can pin a plan to a
deterministic query.

**Status: target-state (gates AC-27d)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"semantic":"nx bugs and apigen"}' --sort relevance --repo adhd --fields humanId,title
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "FEAT-1", title: "apigen java javalin plugin slice 2/3" },
    { humanId: "BUG-1",  title: "nx build fails after fastify bump" }
  ], total: 2, returned: 2 } }
```

✅ **Verify**
- [ ] The explicit form returns the **same items as §3.2** — the NL form's refined result
      is reproducible as `view:list` + filter + semantic (AC-27's parity clause).
- [ ] `sort: "relevance"` is honored in the explicit form.

🔗 **Proves:** AC-27 (parity — same data.query re-run as explicit form)
📎 **Source:** INTERFACE_v2 §2.1b Parity paragraph, §10.10 AC-27(d)

#### 3.4 · Scoped semantic with a teeth-having negative control   (happy + ⚠️)

🎬 **Scene.** Semantic within a repo — and the proof it's the *vector* channel doing the
work, not keyword luck. Zero the vector weight: the paraphrase must fall out of the top
ranks.

**Status: target-state (gates AC-9). Needs real embeddings via the embedding service.**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"repo":"adhd","semantic":"sign-in button unresponsive"}' --sort relevance --fields humanId,title,_score
$ backlog query --view list --filter '{"repo":"adhd","semantic":"sign-in button unresponsive","semanticWeight":0.0}' --sort relevance --fields humanId,title,_score
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", _score: 0.95 },
    { humanId: "BUG-8", title: "auth flow hangs under throttled requests",        _score: 0.81 }
  ], total: 2, returned: 2 } }

{ ok: true, data: { items: [
    { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", _score: ⟨fts⟩ }
  ], total: 1, returned: 1 } }
```

✅ **Verify**
- [ ] Within `repo: adhd`, the **paraphrase BUG-8** ("auth flow hangs under throttled
      requests" — zero shared words with the query) ranks via the vector channel.
- [ ] The exact-word match in another repo (BUG-9 in `sox-ecosystem`) is **absent** —
      repo scoping held; it did not outrank the in-repo paraphrase.
- [ ] **Negative control:** with `semanticWeight: 0.0`, BUG-8 drops out of the results —
      proving the vector channel, not keyword coincidence, produced the paraphrase hit.

🔗 **Proves:** AC-9 (semantic filter scoped; paraphrase above foreign exact-match;
zero-weight negative control)
📎 **Source:** INTERFACE_v2 §10.4 AC-9; RAG-SPEC §8 test-1 negative control; PLUGIN_ARCHITECTURE
§3.1 (vector dim contract). ⟦U14⟧ `semanticWeight` knob spelling for the zero-weight
control (RAG-SPEC names the control, not the surface flag) — see UNRESOLVED.md

#### 3.5 · "Show me what's like this": `view:similar`, two anchors   (happy)

🎬 **Scene.** Maya points at an item instead of typing a sentence — nearest neighbors to
BUG-2's own vector.

**Status: target-state (gates AC-10). Needs the embedding service.**

▶️ **Do**
```bash
$ backlog query --view similar --filter '{"repo":"adhd","semantic":"sign-in button unresponsive"}' --fields humanId,title,_score
$ backlog query --view similar --filter '{"anchor":"BUG-2"}' --fields humanId,title,_score
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "BUG-8", title: "auth flow hangs under throttled requests", _score: 0.81 },
    { humanId: "BUG-1", title: "nx build fails after fastify bump",        _score: 0.41 }
  ], candidates: 2, total: 2 } }

{ ok: true, data: { items: [
    { humanId: "BUG-8", title: "auth flow hangs under throttled requests", _score: 0.83 },
    { humanId: "BUG-3", title: "storybook mcp bridge times out",           _score: 0.44 }
  ], candidates: 2, total: 2 } }
```

✅ **Verify**
- [ ] Free-text anchor returns top-k with `_score` from the matcher; paraphrase BUG-8
      ranks first.
- [ ] Item anchor `{"anchor":"BUG-2"}` needs **no pasted title** — nearest neighbors to
      BUG-2's own vector, BUG-8 again on top.
- [ ] The two anchors are distinct surfaces: `view:similar` is "what's like this", never
      confused with the positional NL form.

🔗 **Proves:** AC-10 (similar view, two anchors, _score)
📎 **Source:** INTERFACE_v2 §2.1b (pure semantic search stays explicit), §10.4 AC-10;
RAG-SPEC §3.2 relatedItems

#### 3.6 · grep stays grep: keyword is keyword, forever   (happy)

🎬 **Scene.** Maya wants the boring, exact, deterministic search too — and needs to know
`grep` never secretly becomes hybrid when embeddings land.

**Status: target-state (gates AC-11)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"repo":"adhd","grep":"sign-in"}' --fields humanId,title
$ backlog query --view list --filter '{"repo":"adhd","grep":"sign-in","semantic":"sign-in button unresponsive"}' --fields humanId,title,_score
```

👀 **Expect**
```
{ ok: true, data: { items: [ { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page" } ], total: 1, returned: 1 } }
{ ok: true, data: { items: [
    { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", _score: ⟨fts+vec⟩ },
    { humanId: "BUG-8", title: "auth flow hangs under throttled requests",        _score: ⟨vec⟩ }
  ], total: 2, returned: 2 } }
```

✅ **Verify**
- [ ] `grep: "sign-in"` returns **pure FTS keyword matches only**: BUG-2, and *not* the
      paraphrase BUG-8 (no keyword "sign-in" in its title).
- [ ] `grep` + `semantic` **compose additively** — the second query returns both the
      exact hit and the semantic hit, neither channel swallowing the other.
- [ ] The shape never changes at the swap: the surface is identical before and after the
      embedding layer lands.

🔗 **Proves:** AC-11 (grep stays FTS, composes with semantic)
📎 **Source:** INTERFACE_v2 §7.6, §10.4 AC-11; RAG-SPEC §3.1 (grep is pure FTS, always)

---

### Act 4 — User Tracking: Who Filed What, Once and Forever

*Maya needs attribution that survives agent restarts: two instances of the same agent are
one author. The identity dimension does the canonicalization.*

#### 4.1 · Filter by author and reporter   (happy)

🎬 **Scene.** "Give me everything authored by `researcher`" — including items filed by
either of the two researcher instances.

**Status: target-state (gates AC-13)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"repo":"adhd","author":"researcher"}' --fields humanId,kind,title,author
$ backlog query --view list --filter '{"reporter":"anna"}' --fields humanId,kind,title
```

👀 **Expect**
```
{ ok: true, data: { items: [ ⟨PLAN-001, BUG-1, BUG-2, BUG-8, FEAT-1, TASK-1, TASK-2⟩, total: 7, returned: 7 } }
{ ok: true, data: { items: [ { humanId: "BUG-6", kind: "BUG", title: "memory server crash on embed batch" } ], total: 1, returned: 1 } }
```

✅ **Verify**
- [ ] `author: "researcher"` matches items authored by **either** `researcher:a1b2c3` or
      `researcher:x9y8z7` (BUG-1 and BUG-2 both present — instance ids stripped).
- [ ] BUG-3 (author `ops`) is excluded when the author filter is present.
- [ ] `reporter: "anna"` returns exactly BUG-6; items missing the reporter field are
      excluded when the filter is present.

🔗 **Proves:** AC-13 (filter by author/reporter; missing-field exclusion)
📎 **Source:** INTERFACE_v2 §10.5 AC-13; GRAPH_MODEL_v2 §2.1.1 (identity canonicalization)

#### 4.2 · Aggregate by reporter — stable across agent runs   (happy)

🎬 **Scene.** Maya's lead asks "how many bugs per reporter". The answer must be stable:
`researcher:x9y8z7` and `researcher:a1b2c3` are **one** researcher, never per-process
buckets.

**Status: target-state (gates AC-14)**

▶️ **Do**
```bash
$ backlog query --view grouped --filter '{"kind":"BUG"}' --group-by reporter
```

👀 **Expect**
```
{ ok: true, data: { buckets: [
    { key: "researcher", count: 6 },
    { key: "ops",        count: 1 },
    { key: "anna",       count: 1 }
  ] } }
```

✅ **Verify**
- [ ] **Exactly three buckets** — BUG-1 (reported by `researcher:a1b2c3`) and BUG-2 /
      BUG-4 (reported by `researcher:x9y8z7`) land in **one `researcher` bucket** (count
      6 = BUG-1, BUG-2, BUG-4, BUG-5, BUG-8, BUG-9).
- [ ] The aggregate matches a manual count per reporter (8 bugs total: 6 + 1 + 1) — never
      per-process-run buckets.
- [ ] This is the `aggregateByDimension` SQL path (GROUP BY over the `REPORTED_BY` edge),
      not a JS post-filter.

🔗 **Proves:** AC-14 (aggregate-by-reporter stable across agent runs)
📎 **Source:** INTERFACE_v2 §10.5 AC-14; GRAPH_MODEL_v2 §2.1.1 (aggregation invariants),
§4 aggregateByDimension

#### 4.3 · The groupBy axes are driven, not prose   (happy)

🎬 **Scene.** Every dimensional + classic axis returns the documented bucket shape on
real data. Maya checks repo, author, and status.

**Status: target-state (gates AC-31b)**

▶️ **Do**
```bash
$ backlog query --view grouped --group-by repo
$ backlog query --view grouped --group-by author
$ backlog query --view grouped --group-by status
```

👀 **Expect**
```
{ ok: true, data: { buckets: [ { key: "adhd", count: 8 }, { key: "sox-ecosystem", count: 5 } ] } }
{ ok: true, data: { buckets: [ { key: "researcher", count: 11 }, { key: "ops", count: 1 }, { key: "anna", count: 1 } ] } }
{ ok: true, data: { buckets: [ { key: "OPEN", count: 11 }, { key: "IN_PROGRESS", count: 1 }, { key: "DONE", count: 1 } ] } }
```

✅ **Verify**
- [ ] Each axis returns the documented `{ buckets: [{ key, count }] }` shape with **exact
      membership**: repo → 8 + 5 (13 items); author → researcher 11 / ops 1 / anna 1;
      status → OPEN 11 / IN_PROGRESS 1 / DONE 1.
- [ ] The `project` and `kind` axes return the same shape (core-platform 8 /
      sox-platform 5; EPIC 1 / BUG 8 / FEAT 2 / TASK 2) — the AC's full axis list is
      driven, not assumed.

🔗 **Proves:** AC-31 (groupBy axes driven on real data)
📎 **Source:** INTERFACE_v2 §10.10 AC-31; §2.2 grouped view; GRAPH_MODEL_v2 §4
(aggregateByDimension)

---

### Act 5 — Rollup & Plan Analysis

*Before Maya resumes her plan, she audits it: summary stats, overlap risk, completeness.
All read-only compositions — the analysis is a query, never a mutation.*

#### 5.1 · Windowed summary with honest coverage   (happy + ⚠️)

🎬 **Scene.** "What happened in the last 30 days?" Maya wants per-status counts, cycle
time, reopen rate — and the coverage note that tells her how much history actually
exists (pre-fix items have none, and the window bounds are honored).

**Status: target-state (gates AC-15)**

▶️ **Do**
```bash
$ backlog query --view summary --filter '{"dateRange":{"updated":{"since":"2026-07-09"}}}'
```

👀 **Expect**
```
{ ok: true, data: {
    window: { since: "2026-07-09", until: "2026-08-08", bucket: "day" },
    perStatus: { OPEN: 11, IN_PROGRESS: 1, DONE: 1 },
    transitions: [
      { period: "2026-08-06", count: 2 },
      { period: "2026-08-07", count: 0 }
    ],
    cycleTime: { medianHours: 24.0, p90Hours: 41.0 },
    reopenRate: 0.0,
    coverage: { itemsWithHistory: 5, itemsTotal: 13, auditWindowStart: "2026-07-09" }
  } }
```

✅ **Verify**
- [ ] `coverage` is **always present** with the pinned fields `{ itemsWithHistory,
      itemsTotal, auditWindowStart }` — partial history is visible, never silent.
- [ ] **Negative control:** BUG-6's transitions (2026-06-15/06-20, outside the window)
      contribute to **no** transitions bucket and do not inflate `reopenRate` (0.0) —
      the bound is honored, not computed from all history.
- [ ] The counts match a manual computation from the audit log for the same window
      (2 transition events on 08-06; none on 08-07).

🔗 **Proves:** AC-15 (windowed summary, coverage, negative control)
📎 **Source:** INTERFACE_v2 §2.2 summary view, §10.6 AC-15; DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001.
⟦U6⟧ summary JSON field names (components are named in the spec; the literal keys are
inferred) — see UNRESOLVED.md

#### 5.2 · Overlap: the wave-collision check, per axis   (happy)

🎬 **Scene.** Before Maya dispatches BUG-6 and FEAT-2 to agents, she checks whether they
touch the same unit of work. File-axis vs project-axis must give *different* answers.

**Status: target-state (gates AC-28)**

▶️ **Do**
```bash
$ backlog query --view overlap --overlap-by file --humanIds "[BUG-6,FEAT-2]"
$ backlog query --view overlap --overlap-by project --humanIds "[BUG-6,FEAT-2]"
```

👀 **Expect**
```
{ ok: true, data: { pairs: [ { a: "BUG-6", b: "FEAT-2", shared: ["packages/sox-memory-core/src/host.ts"] } ] } }
{ ok: true, data: { pairs: [ { a: "BUG-6", b: "FEAT-2", shared: ["sox-platform"] } ] } }
```

✅ **Verify**
- [ ] Both BUG-6 and FEAT-2 carry `files[]` including `packages/sox-memory-core/src/host.ts`
      (fixture §2.2), so the file axis reports that shared unit.
- [ ] `--overlap-by file` and `--overlap-by project` return **different results** — the
      axes are distinct, asserted not assumed.
- [ ] The result shape is uniform pairwise `{ a, b, shared: [...] }`; the tool reports
      declared overlap — it never reads the filesystem and never chooses the wave.

🔗 **Proves:** AC-28 (overlap by project; file-vs-project distinctness)
📎 **Source:** INTERFACE_v2 §5a.3, §10.10 AC-28

#### 5.3 · Acceptance-criteria and citation completeness   (happy)

🎬 **Scene.** "Which plan members are missing acceptance criteria — or any evidence at
all?" Presence is queryable; content is never parsed.

**Status: target-state (gates AC-29)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"plan":"PLAN-001","missingAcceptanceCriteria":true}' --fields humanId,title
$ backlog query --view list --filter '{"plan":"PLAN-001","hasAcceptanceCriteria":true}' --fields humanId,title
$ backlog query --view list --filter '{"plan":"PLAN-001","missingCitation":true}' --fields humanId,title
```

👀 **Expect**
```
{ ok: true, data: { items: [ { humanId: "TASK-2", title: "shell completion for enum flags" } ], total: 1, returned: 1 } }
{ ok: true, data: { items: [ ⟨TASK-1, BUG-1, FEAT-1⟩ ], total: 3, returned: 3 } }
{ ok: true, data: { items: [ { humanId: "TASK-2", title: "shell completion for enum flags" } ], total: 1, returned: 1 } }
```

✅ **Verify**
- [ ] `missingAcceptanceCriteria: true` returns **exactly** the plan member whose body
      lacks a criteria section (TASK-2) — and `hasAcceptanceCriteria: true` returns the
      complement (TASK-1, BUG-1, FEAT-1).
- [ ] `missingCitation: true` returns the member with zero citations (TASK-2) — the
      read-side mirror of the evidence gate.
- [ ] The filters detect the signal (a `## Criteria` heading or `metadata.criteria`);
      they never parse clause content.

🔗 **Proves:** AC-29 (acceptance-criteria presence filters)
📎 **Source:** INTERFACE_v2 §5a.7, §10.10 AC-29

#### 5.4 · What's claimable now: `view:ready`   (happy)

🎬 **Scene.** Maya asks for the dispatchable set — non-terminal, unclaimed, unblocked —
and gets exactly that, no more, no less.

**Status: target-state (gates AC-31a)**

▶️ **Do**
```bash
$ backlog query --view ready --repo adhd --fields humanId,kind,title,status
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "PLAN-001", kind: "EPIC", title: "Interface v2 rollout", status: "OPEN" },
    { humanId: "BUG-2",    kind: "BUG",  title: "sign-in button unresponsive on rate-limit page", status: "OPEN" },
    { humanId: "BUG-3",    kind: "BUG",  title: "storybook mcp bridge times out", status: "OPEN" },
    { humanId: "BUG-8",    kind: "BUG",  title: "auth flow hangs under throttled requests", status: "OPEN" },
    { humanId: "TASK-2",   kind: "TASK", title: "shell completion for enum flags", status: "OPEN" }
  ], total: 5, returned: 5 } }
```

✅ **Verify**
- [ ] **Exactly** the non-terminal ∧ unclaimed ∧ unblocked adhd items: no claimed item
      (BUG-1 — claimed by maya), no blocked item (FEAT-1 — blocked by BUG-4), no terminal
      item (TASK-1 — DONE). A superset of nothing else.
- [ ] PLAN-001 is present per the literal predicate (non-terminal, unclaimed,
      unblocked) — the parent-inclusion question is flagged, not decided here.

🔗 **Proves:** AC-31 (ready view exact)
📎 **Source:** INTERFACE_v2 §2.2 ready view, §10.10 AC-31. ⟦U7⟧ parent/root inclusion in
ready is unspecified — see UNRESOLVED.md

---

### Act 6 — Filing Interception

*The flagship of the create path: Maya tries to file a duplicate and the surface stops
her — then gives her one-action escape hatches, never a silent drop.*

#### 6.1 · The default: refuse, show the canonical, create nothing   (happy + ⚠️)

🎬 **Scene.** Maya re-files BUG-2's title verbatim (a third time — someone keeps hitting
the same bug). The dedupe scan runs *before* the create and refuses.

**Status: target-state (gates §3 filing-time interception; AC-17's counter feeds it)**

▶️ **Do**
```bash
$ backlog create --title "sign-in button unresponsive on rate-limit page" --kind BUG --repo adhd --by maya
```

👀 **Expect**
```
{ ok: false, error: {
    code: "duplicate_candidate",
    message: "draft is a near-duplicate of BUG-2 (score 0.94); nothing was created — pass --duplicate-action file|comment to proceed",
    details: { canonical: "BUG-2", duplicateCandidates: [ { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", score: 0.94 } ] }
  } }
```

✅ **Verify**
- [ ] `ok: false`, code `duplicate_candidate`, and the **canonical item BUG-2** with its
      candidate score — the operator can see exactly what collided.
- [ ] **Nothing was created:** a follow-up `--view list --repo adhd` total is still 8.
- [ ] The switch is named in the error (`--duplicate-action`), never a guessed `confirm`
      boolean.

🔗 **Proves:** AC-17 (dupe counter/demand surface) · §3 contract (interception on create)
📎 **Source:** INTERFACE_v2 §3 (filing-time interception, duplicateAction), §7.1 code
`duplicate_candidate`. ⟦U8⟧ CLI create flag spellings (--title/--kind/--repo/--by) —
see UNRESOLVED.md. ⟦U2⟧ CLI exit code for `duplicate_candidate` is unmapped in §7.2 —
see UNRESOLVED.md

#### 6.2 · One action, no new item: `duplicateAction: comment`   (happy)

🎬 **Scene.** Maya decides the report is still valuable — as a note on the canonical
item, with the dupe counter incremented so demand is visible.

**Status: target-state (gates §3 duplicateAction contract)**

▶️ **Do**
```bash
$ backlog create --title "sign-in button unresponsive on rate-limit page" --kind BUG --repo adhd --by maya --duplicate-action comment
```

👀 **Expect**
```
{ ok: true, data: { humanId: "BUG-2", changed: ["notes"], noteId: "N-⟨n⟩", dupeHits: 3, action: "comment" } }
```

✅ **Verify**
- [ ] `ok: true` with an **outcome-reporting envelope** — the canonical `humanId`
      (BUG-2), the changed field, and a real `noteId` (never a bare void success).
- [ ] **dupeHits incremented 2 → 3** — the draft became a note on the canonical item and
      its demand counter rose; no new item exists.

🔗 **Proves:** §3 duplicateAction contract · §4 outcome-reporting · AC-17 (counter feeds
demand)
📎 **Source:** INTERFACE_v2 §3 (comment path), §4 outcome contract, §7.3 projection;
DEBT-BACKLOG-API-RETURN-VALUES-001

#### 6.3 · Demand: the re-filed item surfaces on top   (happy + ⚠️)

🎬 **Scene.** "What's being hit over and over?" — the dupe counter becomes a ranking
signal, and the weighting must not be an incidental tiebreak.

**Status: target-state (gates AC-17)**

▶️ **Do**
```bash
$ backlog query --view list --sort demand --repo adhd --fields humanId,title,dupeHits
$ backlog query --view list --filter '{"repo":"adhd","dupeHitsMin":2}' --fields humanId,title,dupeHits
```

👀 **Expect**
```
{ ok: true, data: { items: [
    { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", dupeHits: 3 },
    ⟨the other adhd items, dupeHits: 0⟩
  ], total: 8, returned: 8 } }
{ ok: true, data: { items: [ { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page", dupeHits: 3 } ], total: 1, returned: 1 } }
```

✅ **Verify**
- [ ] `--sort demand` ranks BUG-2 (re-filed 3×) **above** every once-filed item.
- [ ] `--filter '{"dupeHitsMin":2}'` returns **only** re-filed items (BUG-2).
- [ ] **Negative control:** under a recency-heavy weighting perturbation, BUG-2 stays
      above once-filed items — the dupe counter is the dominant demand term, not a
      tiebreak.

🔗 **Proves:** AC-17 (demand sort, dupeHitsMin, negative control)
📎 **Source:** INTERFACE_v2 §2.3 sort:demand, §10.6 AC-17, §8 (FEAT-013 row)

#### 6.4 · Split/supersede cannot silently mint   (⚠️ edge)

🎬 **Scene.** Maya supersedes BUG-3 with a re-filed report. The silent-drop class —
supersede used to skip the dedupe scan and mint anyway — must be closed.

**Status: target-state (gates §3 silent-drop guard)**

▶️ **Do**
```bash
$ backlog create --supersedes BUG-3 --title "storybook mcp bridge times out (reported again)" --kind BUG --repo adhd --by maya
```

👀 **Expect**
```
{ ok: false, created: false, error: {
    code: "dedupe_suppressed",
    message: "supersede target BUG-3 matched the dedupe scan; nothing minted",
    details: { duplicateCandidates: [ { humanId: "BUG-3", title: "storybook mcp bridge times out", score: 0.97 } ], reason: "duplicate-suppressed" }
  } }
```

✅ **Verify**
- [ ] `created: false` with code `dedupe_suppressed` and the matched candidates — the
      supersede path runs the dedupe scan *before* minting, exactly like create
      (BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001).
- [ ] No new item and no edge were written; BUG-3 is untouched.

🔗 **Proves:** §3 silent-drop guard (split/supersede interception)
📎 **Source:** INTERFACE_v2 §3 (guard at the OP layer for split/supersede); GRAPH_MODEL_v2
§5.1 (supersedeItemNode never mints on suppression)

---

### Act 7 — Projection Discipline

*The context-blow fix: terse by default, full bodies and embedding blobs opt-in, one
`fields` grammar everywhere.*

#### 7.1 · The default card is five fields, always   (happy)

🎬 **Scene.** Maya lists items and gets *cards*, not a 90 KB body dump. The 36-item
list that once cost 90 KB of context now costs a few hundred bytes.

**Status: target-state (gates AC-18)**

▶️ **Do**
```bash
$ backlog query --view list --repo adhd --limit 1 | jq '.data.items[0]'
```

👀 **Expect**
```
{ "humanId": "BUG-1", "kind": "BUG", "title": "nx build fails after fastify bump", "status": "IN_PROGRESS", "priority": "HIGH" }
```

✅ **Verify**
- [ ] The card has **exactly** `humanId, kind, title, status, priority` — no `body`, no
      `_vector`, no embedding blob, no notes.
- [ ] `backlog get`'s single-item card adds `projectPath, updatedAt` (§1, shown in §1.3)
      — the stated affordance, not a silent extra.
- [ ] The same five-field default holds across `backlog_query` views.

🔗 **Proves:** AC-18 (default card shape)
📎 **Source:** INTERFACE_v2 §2.4, §10.7 AC-18

#### 7.2 · Opt-in fields, and an unknown field is an error   (happy + ⚠️)

🎬 **Scene.** Maya asks for depth when she needs it — and tests that a typo is caught,
not silently dropped.

**Status: target-state (gates AC-19)**

▶️ **Do**
```bash
$ backlog query --view list --repo adhd --limit 1 --fields humanId,title,body,citations,author,reporter,_score | jq '.data.items[0] | keys'
$ backlog query --view list --repo adhd --fields humanId,bogus ; echo $?
```

👀 **Expect**
```
["humanId","title","body","citations","author","reporter","_score"]
{ ok: false, error: { code: "validation", message: "unknown field 'bogus'", details: { allowed: ⟨projection vocabulary⟩ } } }
$ echo $?
2
```

✅ **Verify**
- [ ] `--fields` returns **exactly** the requested fields, including the full `body` and
      structured `citations` (opt-in, never default).
- [ ] An unknown field is a `validation` error with **exit 2** — never a silent omission
      of the field.
- [ ] The CLI `--fields` comma-list and the MCP/REST JSON array speak the same grammar.

🔗 **Proves:** AC-19 (opt-in fields; unknown field → validation, exit 2)
📎 **Source:** INTERFACE_v2 §7.3 projection grammar, §10.7 AC-19

#### 7.3 · Embedding blobs are never on by default   (happy)

🎬 **Scene.** Vectors are only ever a few bytes away — but never in the default payload,
and aggregates never leak bodies.

**Status: target-state (gates AC-20)**

▶️ **Do**
```bash
$ backlog query --view list --repo adhd --limit 1 --fields humanId,title,_vector | jq '.data.items[0] | keys'
$ backlog query --view grouped --group-by kind | jq '.data | keys'
$ backlog query --view summary | jq '.data | keys'
```

👀 **Expect**
```
["humanId","title","_vector"]
["buckets"]
["window","perStatus","transitions","cycleTime","reopenRate","coverage"]
```

✅ **Verify**
- [ ] `_vector` appears **only** when explicitly requested (opt-in).
- [ ] `view:grouped` returns the bucket shape and **no item bodies or blobs**; `view:summary`
      returns the aggregate shape and **no item bodies or blobs**.

🔗 **Proves:** AC-20 (blob opt-in; summary/grouped never return bodies or blobs)
📎 **Source:** INTERFACE_v2 §2.4, §10.7 AC-20

---

## 4 · The Climax — The Resume: One Call, No Ledger

*This is the payoff the whole demo built toward: a killed session picks up where it left
off from a single tool call. The timestamp is tool-native (an `asOf` token), never a
hand-persisted ledger entry. This is Maya's own canonical use case — a product agent's
planning session that must survive death (INTERFACE_v2 §5a.6).*

#### 4.1 · "Where was I?" — one call answers everything   (happy, the payoff)

🎬 **Scene.** Maya's session died at 08-05. She makes exactly one call: plan card, rollup,
ready set, blocked set, delta since her checkpoint, needs-human set, her own claims — and
a checkpoint token for next time.

**Status: target-state (gates AC-16). Pure read composition — testable now, no EPIC-B
statuses required.**

▶️ **Do**
```bash
$ backlog query --view plan --filter '{"plan":"PLAN-001","claimedBy":"maya","dateRange":{"updated":{"since":"2026-08-05"}}}' --fields humanId,kind,title,status,priority
```

👀 **Expect**
```
{ ok: true, data: {
    plan: { humanId: "PLAN-001", kind: "EPIC", title: "Interface v2 rollout", status: "OPEN", priority: "HIGH" },
    rollup: { childrenTotal: 4, childrenClosed: 1, childrenOpen: [ { humanId: "TASK-2", ... }, { humanId: "BUG-1", ... }, { humanId: "FEAT-1", ... } ], selfVerified: false },
    ready: [ { humanId: "TASK-2", title: "shell completion for enum flags", status: "OPEN", priority: "LOW" } ],
    blocked: [ { humanId: "FEAT-1", blockedBy: "BUG-4" } ],
    delta: [
      { humanId: "TASK-1", event: "transition", from: "IN_PROGRESS", to: "DONE", at: "2026-08-06T15:04:00Z" },
      { humanId: "BUG-1",  event: "claim", by: "maya", at: "2026-08-06T09:12:00Z" }
    ],
    needsHuman: [ { humanId: "TASK-2", title: "shell completion for enum flags" } ],
    myClaims: [ { humanId: "BUG-1", title: "nx build fails after fastify bump", status: "IN_PROGRESS" } ],
    asOf: "⟨asof-1-token⟩"
  } }
```

✅ **Verify**
- [ ] **One call** returns the plan card, the two-axis rollup (`childrenClosed` +
      `selfVerified` — not a single boolean), the ready set, the blocked set *with the
      blocking dependency*, the transition delta since the checkpoint, the needs-human
      set, **and `myClaims`** (the caller's own in-progress item BUG-1, from
      `filter.claimedBy`) — no second query.
- [ ] `asOf` is a **checkpoint token**, not a hand-persisted ISO timestamp.
- [ ] The needs-human set is derived from existing state (non-terminal, unclaimed,
      blocked on nothing external) — testable without EPIC-B statuses.

🔗 **Proves:** AC-16 (plan resume: rollup, ready, blocked, delta, needsHuman, myClaims,
asOf)
📎 **Source:** INTERFACE_v2 §2.2 plan view, §5a.6 (resume is a tool surface), §10.6 AC-16,
§9 Q11

#### 4.2 · The token is real: delta shrinks   (happy)

🎬 **Scene.** Maya resumes *again* in a fresh session, passing the first call's `asOf` as
the next `since`. The delta must shrink — proving the token, not a guessed timestamp.

**Status: target-state (gates AC-16 provenance)**

▶️ **Do**
```bash
$ backlog query --view plan --filter '{"plan":"PLAN-001","claimedBy":"maya","dateRange":{"updated":{"since":"⟨asof-1-token⟩"}}}' --fields humanId,kind,title,status,priority
```

👀 **Expect**
```
{ ok: true, data: { plan: ⟨same card⟩, rollup: ⟨same⟩, ready: ⟨same⟩, blocked: ⟨same⟩,
    delta: [], needsHuman: ⟨same⟩, myClaims: ⟨same⟩, asOf: "⟨asof-2-token⟩" } }
```

✅ **Verify**
- [ ] The second call's `delta` is **empty** (or strictly smaller) — nothing changed
      since the first call's checkpoint: the token is real, and a fresh session using the
      returned token resumes correctly.
- [ ] The second `asOf` token differs from the first (a new checkpoint, never a replay).

🔗 **Proves:** AC-16 (asOf provenance pinned)
📎 **Source:** INTERFACE_v2 §10.6 AC-16 ("call the view twice — first call's asOf becomes
the second call's since")

#### 4.3 · What must be worked first: criticalPath   (happy)

🎬 **Scene.** Before dispatching, Maya wants the weighted longest path through the
plan's dependencies — the chain that gates everything else.

**Status: target-state (gates AC-30). Pure graph traversal — no embedding dependency.**

▶️ **Do**
```bash
$ backlog query --view plan --filter '{"plan":"PLAN-001"}' --weight-fn count --fields humanId,title
```

👀 **Expect**
```
{ ok: true, data: { criticalChain: [
    { humanId: "FEAT-1", title: "apigen java javalin plugin slice 2/3" },
    { humanId: "BUG-1",  title: "nx build fails after fastify bump" }
  ], length: 2, endItem: "BUG-1" } }
```

✅ **Verify**
- [ ] The chain BUG-1 → FEAT-1 (BUG-1 `DEPENDS_ON` FEAT-1) is the plan's longest path:
      `length: 2`, `endItem: "BUG-1"`.
- [ ] The independent TASK-2's path is length 1 — **strictly less** than the chain
      (the critical-path contract, AC-30).

🔗 **Proves:** AC-30 (criticalPath pinned contract)
📎 **Source:** INTERFACE_v2 §5a.8, §10.10 AC-30; RAG-SPEC §5 criticalPath. ⟦U9⟧
`--weight-fn` CLI spelling inferred from the `weightFn` param — see UNRESOLVED.md

#### 4.4 · How much work does this unblock? blockerImpact   (happy + ⚠️)

🎬 **Scene.** BUG-5 is the base of the chain. Maya asks how much work sits on top of it —
and the answer must be the *transitive* cone, not just direct dependents.

**Status: target-state (gates AC-30). Pure graph traversal.**

▶️ **Do**
```bash
$ backlog query --view order --filter '{"humanId":"BUG-5"}' --fields humanId,title
```

👀 **Expect**
```
{ ok: true, data: { order: ⟨topological order with wave numbers⟩,
    blockerImpact: { humanId: "BUG-5", impactedCount: 3, impactedOpenCount: 3, impactedHumanIds: ["BUG-4", "FEAT-1", "BUG-1"] } } }
```

✅ **Verify**
- [ ] `impactedCount: 3` — the **transitive** cone BUG-4 → FEAT-1 → BUG-1, not just the
      direct dependent BUG-4.
- [ ] **Negative control:** with traversal depth capped at 1, `impactedCount` drops to 1
      — proving transitivity is exercised, not assumed.

🔗 **Proves:** AC-30 (blockerImpact transitive cone; negative control)
📎 **Source:** INTERFACE_v2 §5a.8, §10.10 AC-30; RAG-SPEC §8 test-5 (negative control:
cap depth at 1)

---

## 5 · Resilience Sweep — Error & Edge Honesty

*The adversarial cases that didn't fit the story, mopped up so coverage is total. Every
error below is a designed contract (INTERFACE_v2 §7.1/§7.2), never an accident.*

#### 5.1 · Exit codes and error codes: the full matrix   (⚠️ edge)

🎬 **Scene.** Scripts live and die by exit codes. Maya drives all four states — plus the
empty list from §2.4.

**Status: target-state (gates AC-6)**

▶️ **Do**
```bash
$ backlog get --human-id NOPE-99 ; echo "exit=$?"
$ backlog frobnicate ; echo "exit=$?"
$ backlog query --view list --repo adhd --limit 9999 ; echo "exit=$?"
$ backlog query --view list --bogus 1 ; echo "exit=$?"
```

👀 **Expect**
```
{ ok: false, error: { code: "item_not_found", message: "no item with humanId 'NOPE-99'" } }
exit=1
{ ok: false, error: { code: "not_found", message: "unknown command 'frobnicate'" } }
exit=4
{ ok: false, error: { code: "validation", message: "limit 9999 exceeds MAX_LIMIT 1000" } }
exit=2
{ ok: false, error: { code: "invalid_argument", message: "unknown flag '--bogus'" } }
exit=2
```

✅ **Verify**
- [ ] Single-item miss → `item_not_found`, **exit 1** — distinguishable from unknown
      command (4) and internal error (1 is never reused for misses).
- [ ] Unknown command → `not_found`, **exit 4**.
- [ ] Bad flag / over-limit → `invalid_argument` / `validation`, **exit 2** — never a
      silent cap or no-op.
- [ ] Empty list results stay `ok: true, data: []`, **exit 0** (§2.4) — a list is never
      "not found".

🔗 **Proves:** AC-6 (envelope + exit codes)
📎 **Source:** INTERFACE_v2 §7.2 exit codes (verified against apigen-base-errors
errors.ts:58-63), §10.2 AC-6

#### 5.2 · The agent-error trap: view/sort inside --filter   (⚠️ edge)

🎬 **Scene.** Maya's agents habitually nest top-level params inside `--filter`. The error
must name the stray keys — and never silently "work".

**Status: target-state (gates AC-23)**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"view":"list"}' ; echo "exit=$?"
$ backlog query --view list --filter '{"bogusKey":true}' ; echo "exit=$?"
```

👀 **Expect**
```
{ ok: false, error: { code: "invalid_argument", message: "stray top-level keys inside --filter: view (use the top-level --view flag)", details: { strayKeys: ["view"] } } }
exit=2
{ ok: false, error: { code: "validation", message: "unknown filter key 'bogusKey'", details: { allowed: ⟨filter key vocabulary⟩ } } }
exit=2
```

✅ **Verify**
- [ ] `{"view":"list"}` inside `--filter` → `invalid_argument` naming the stray key,
      exit 2 — the most common agent error gets an actionable message, never a
      works-by-accident result.
- [ ] An unknown filter key → `validation`, exit 2 (`additionalProperties: false`).

🔗 **Proves:** AC-23 (filter validation; stray-key error)
📎 **Source:** INTERFACE_v2 §2.1a, §7.8, §10.9 AC-23

#### 5.3 · Soft-deleted items keep their history reachable   (🛟 recovery)

🎬 **Scene.** Maya retires the real duplicate BUG-9 (already reported as BUG-2). The
soft-delete must report its outcome — and the tombstone's audit history must stay
reachable.

**Status: target-state (gates §1 soft_deleted reachability; AC: §8
BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001)**

▶️ **Do**
```bash
$ backlog update --human-id BUG-9 --soft-delete-reason "duplicate of BUG-2" --by maya
$ backlog get --human-id BUG-9 --fields humanId,title,status,audit_trail
```

👀 **Expect**
```
{ ok: true, data: { humanId: "BUG-9", changed: ["status"], newStatus: "SOFT_DELETED" } }
{ ok: true, data: { humanId: "BUG-9", title: "sign-in button unresponsive on rate-limit page (dupe of BUG-2)", status: "SOFT_DELETED",
    audit_trail: [ ⟨creation + transition events⟩, { event: "soft_delete", reason: "duplicate of BUG-2", by: "maya", at: "⟨ts⟩" } ] } }
```

✅ **Verify**
- [ ] The update reports its outcome — `changed: ["status"]`, `newStatus:
      "SOFT_DELETED"` (no bare void success).
- [ ] `backlog get` on the soft-deleted item still reaches the card **and** its full
      audit history, including the soft-delete event itself — history is never lost with
      the live row.

🔗 **Proves:** §1 soft_deleted outcome · BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 (audit
reachable after soft-delete)
📎 **Source:** INTERFACE_v2 §1 (soft_deleted; getNode reads t_invalid rows), §4 outcome
contract. ⟦U10⟧ exact get-on-tombstone semantics (reachable card vs `soft_deleted` error
code split) — see UNRESOLVED.md

#### 5.4 · No embeddings? Degrade loudly, keep keyword alive   (⚠️ edge)

🎬 **Scene.** A fresh store without the embedding plugin. Semantic must *refuse* — never
quietly downgrade to keyword — while grep and dimensional queries keep working.

**Status: target-state (gates AC-12). Shipped-today contrast: `grep` FTS works today and
keeps working.**

▶️ **Do**
```bash
$ backlog query --view list --filter '{"semantic":"sign-in button unresponsive"}' --sort relevance
$ backlog query --view similar --filter '{"anchor":"BUG-2"}'
$ backlog query --view list --filter '{"repo":"adhd","grep":"sign-in"}' --fields humanId,title
```

👀 **Expect**
```
{ ok: false, error: { code: "rag_not_configured", message: "no embedding provider configured — add the embedding-remote plugin, or use grep for keyword search" } }
{ ok: false, error: { code: "rag_not_configured", message: "no embedding provider configured" } }
{ ok: true, data: { items: [ { humanId: "BUG-2", title: "sign-in button unresponsive on rate-limit page" } ], total: 1, returned: 1 } }
```

✅ **Verify**
- [ ] `semantic`, `view:similar`, and `sort: relevance` all return `rag_not_configured` —
      a caller relying on vector recall is never quietly downgraded.
- [ ] `grep` and dimensional queries **still work** on the same store — the v1 surface
      never regresses (RAG-SPEC §1 principle 6).

🔗 **Proves:** AC-12 (degrade contract)
📎 **Source:** INTERFACE_v2 §10.4 AC-12; RAG-SPEC §1.6, §8 test-7; PLUGIN_ARCHITECTURE §4
(absent opts.embedding → RagNotConfiguredError)

#### 5.5 · Attribution is never silently stamped   (happy + ⚠️)

🎬 **Scene.** The CLI can derive `by` from the identity chain; a stateless MCP/REST call
cannot — and must reject.

**Status: target-state (gates AC-26). The CLI identity chain (`currentActor()`) ships
today; MCP/REST rejection is target-state.**

▶️ **Do**
```bash
$ git config user.name
$ backlog update --human-id BUG-8 --status IN_PROGRESS
$ curl -s -X POST http://127.0.0.1:8787/update -H 'content-type: application/json' \
    -d '{"humanId":"BUG-8","status":"OPEN"}'
```

👀 **Expect**
```
Maya Reyes
{ ok: true, data: { humanId: "BUG-8", changed: ["status", "claimState"], newStatus: "IN_PROGRESS", claimState: { by: "Maya Reyes", at: "⟨ts⟩" } } }
{ ok: false, error: { code: "invalid_argument", message: "missing required parameter 'by' — MCP/REST transports are stateless; attribution is mandatory" } }
```

✅ **Verify**
- [ ] The CLI mutation without `--by` succeeds, attributed via the identity chain
      (`git config user.name` → "Maya Reyes"; env override wins when set).
- [ ] The REST route rejects the same mutation with `invalid_argument` naming `by` —
      an unattributed mutation is never silently stamped.

🔗 **Proves:** AC-26 (CLI identity chain; MCP/REST require by)
📎 **Source:** INTERFACE_v2 §7.5 (by resolves from identity chain; mandatory per-call on
MCP/REST), §10.9 AC-26

---

## 6 · Teardown — Back to Zero

🎬 **Scene.** Demo over. Maya stops the servers and removes the demo store — proving the
script leaves no residue.

▶️ **Do**
```bash
$ pkill -f "backlog serve" ; sleep 0.5
$ rm -rf tmp/backlog-demo
$ lsof -nP -i :8787 -i :8788 -i :8789 ; echo "lsof exit=$?"
$ ls tmp/backlog-demo 2>&1
```

👀 **Expect**
```
$ lsof -nP -i :8787 -i :8788 -i :8789
lsof exit=1
$ ls tmp/backlog-demo
ls: tmp/backlog-demo: No such file or directory
```

✅ **Verify**
- [ ] No process listens on 8787/8788/8789 (`lsof` exit 1 = no matches).
- [ ] `tmp/backlog-demo` is gone — the store and its fixtures leave no residue.
- [ ] The run drove the **real** built binary, **real** HTTP routes, and a **real** store
      throughout — every assertion above was against shipped artifacts, not mocks.

🔗 **Proves:** AC-21 (real transports exercised end to end) · cold-start→teardown
reproducibility
📎 **Source:** INTERFACE_v2 §10.8 AC-21; repo AGENTS.md §10 (ephemeral artifacts under
tmp/, cleaned)

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements (AC-0..AC-31) → Beats

| AC | Requirement (short) | Proven by beat(s) | Paths (H/E/R) | Status |
|---|---|---|---|---|
| AC-0 | One package, four mounts; 6 verbs; install/serve NOT among the six | 2.4, 1.1, 1.3 | H + negative | ☐ |
| AC-1 | serve --transport http; GET / lists operations; envelope over HTTP | 1.3 | H | ☐ |
| AC-2 | /meta/openapi OpenAPI 3.1 derived from descriptors | 1.4 | H | ☐ |
| AC-3 | serve --transport both: HTTP + MCP independent | 1.5 | H | ☐ |
| AC-4 | serve --transport mcp unchanged | 1.5 | H | ☐ |
| AC-5 | Flat verbs rejected with pointer; view:list/order/stale parity | 1.2 | E | ☐ |
| AC-6 | Envelope + exit codes (0/1/2/4; empty list = ok:true, exit 0) | 5.1, 2.4 | E | ☐ |
| AC-7 | Single-repo filter incl. fork-key aliases | 2.1 | H | ☐ |
| AC-8 | Cross-repo dependency surfaced; project-level traversal | 2.3 | H | ☐ |
| AC-9 | Scoped semantic; paraphrase above foreign exact match; zero-weight control | 3.4 | H + E | ☐ |
| AC-10 | view:similar, two anchors, _score | 3.5 | H | ☐ |
| AC-11 | grep stays FTS; composes with semantic | 3.6 | H | ☐ |
| AC-12 | rag_not_configured degrade; grep still works | 5.4 | E | ☐ |
| AC-13 | Filter by author/reporter; missing-field exclusion | 4.1 | H | ☐ |
| AC-14 | Aggregate-by-reporter stable across agent runs | 4.2 | H | ☐ |
| AC-15 | Windowed summary + coverage; window bound honored | 5.1 | H + E | ☐ |
| AC-16 | Plan resume: rollup/ready/blocked/delta/needsHuman/myClaims/asOf; provenance | 4.1, 4.2 | H | ☐ |
| AC-17 | Demand sort; dupeHitsMin; counter-dominant negative control | 6.3, 6.1, 6.2 | H + E | ☐ |
| AC-18 | Default card: humanId, kind, title, status, priority | 7.1, 1.3 | H | ☐ |
| AC-19 | Opt-in fields; unknown field → validation, exit 2 | 7.2 | H + E | ☐ |
| AC-20 | Blob opt-in; summary/grouped never bodies/blobs | 7.3 | H | ☐ |
| AC-21 | Real artifacts driven through real seams | 2.4, 6 (teardown) | H | ☐ |
| AC-22 | Flag sugar == JSON filter; --since natural language | 2.2 | H | ☐ |
| AC-23 | Filter validation; stray top-level keys named | 5.2 | E | ☐ |
| AC-24 | Ambiguity → warnings, never silent narrow | 2.4 | E | ☐ |
| AC-25 | { total, returned } pinned in envelope | 2.1 | H | ☐ |
| AC-26 | CLI identity chain; MCP/REST reject absent by | 5.5 | H + E | ☐ |
| AC-27 | NL query: semantic-first, cross-repo, planner as boost, parity | 3.1, 3.2, 3.3 | H | ☐ |
| AC-28 | Overlap by project; file-vs-project distinctness | 5.2 | H | ☐ |
| AC-29 | Acceptance-criteria/citation presence filters | 5.3 | H | ☐ |
| AC-30 | Plan-graph ops: criticalPath, blockerImpact transitive cone + negative control | 4.3, 4.4 | H + E | ☐ |
| AC-31 | view:ready exact; groupBy axes driven | 5.4, 4.3 | H | ☐ |

**Spec contracts without a numbered AC** (proven by the beats in parentheses): §3
filing-time interception / `duplicateAction` (6.1, 6.2); §3 silent-drop guard for
split/supersede (6.4); §1 `soft_deleted` reachability (5.3); §4 outcome-reporting
contract (6.2, 5.3).

### 7.2 Demo Section → ACs

| Section | Proves |
|---|---|
| Act 1 Onboarding (1.1–1.5) | AC-0, AC-5, AC-1, AC-2, AC-3, AC-4 |
| Act 2 Dimensional Queries (2.1–2.4) | AC-7, AC-25, AC-22, AC-8, AC-24, AC-6 |
| Act 3 NL Query (3.1–3.6) | AC-27, AC-9, AC-10, AC-11 |
| Act 4 User Tracking (4.1–4.3) | AC-13, AC-14, AC-31 |
| Act 5 Rollup & Plan Analysis (5.1–5.4) | AC-15, AC-28, AC-29, AC-31 |
| Act 6 Filing Interception (6.1–6.4) | AC-17, §3 interception + silent-drop guard |
| Act 7 Projection Discipline (7.1–7.3) | AC-18, AC-19, AC-20 |
| §4 Climax — The Resume (4.1–4.4) | AC-16, AC-30 |
| §5 Resilience Sweep (5.1–5.5) | AC-6, AC-23, §1 soft_deleted, AC-12, AC-26 |
| §6 Teardown | AC-21 |
| §2.4 Cold Start | AC-21, AC-0 |

### 7.3 Unresolved Interfaces & Gaps

- **13 interface stubs (U1–U14, U11 unused)** and 0 silent scope gaps; full
  ledger in `UNRESOLVED.md` beside this file.
- Highest impact to resolve first: ⟦U1⟧ (EPIC-A project-level traversal — AC-8's second
  half has no pinned invocation), ⟦U6⟧ (summary JSON field names — AC-15 pins `coverage`
  only), ⟦U7⟧ (parent/root inclusion in `view:ready`), ⟦U10⟧ (get-on-tombstone semantics
  — reachable card vs `soft_deleted` error).
- **Negative control accountability:** every step in §1.2, §3.4, §3.5, §5.1, §4.4 is a
  deliberate control whose assertion *fails if the shipped behavior regresses* — the
  demo documents the 6-verb surface, not the old one.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of 32 ACs⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every AC in §7.1 is proven.
> One unchecked binary assertion = FAIL until resolved.
