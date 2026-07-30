Here is the full mapping of all 36 original commands grouped into the new consolidated tool surface, including how parameters translate.

---

### 1. `backlog_get` (3 original commands)

Handles single-item inspection and deep context retrieval.

* `backlog get-item` $\rightarrow$ **Default response**
* `backlog audit-trail` $\rightarrow$ `backlog_get({ humanId, include: ["audit_trail"] })`
* `backlog blockers` $\rightarrow$ `backlog_get({ humanId, include: ["blockers"] })`

---

### 2. `backlog_query` (5 original commands)

Handles search, filtering, and structural visualization views.

* `backlog list-items` $\rightarrow$ `backlog_query({ view: "list", filter })`
* `backlog ready-items` $\rightarrow$ `backlog_query({ view: "ready", scope })`
* `backlog spotlight` $\rightarrow$ `backlog_query({ view: "spotlight", scope, limit })`
* `backlog topo-order` $\rightarrow$ `backlog_query({ view: "topo", scope })`
* `backlog dependency-graph` $\rightarrow$ `backlog_query({ view: "graph", scope })`

---

### 3. `backlog_create` (3 original commands)

Handles item instantiation and creation variants.

* `backlog create-item` $\rightarrow$ **Default behavior:** `backlog_create({ input })`
* `backlog split-item` $\rightarrow$ `backlog_create({ input, splitFrom: parentHumanId, children })`
* `backlog supersede-item` $\rightarrow$ `backlog_create({ input: newInput, supersedes: oldHumanId, reason })`

---

### 4. `backlog_update` (12 original commands)

Handles all state mutations, lifecycle progression, assignments, and notes.

* `backlog update-item` $\rightarrow$ `backlog_update({ humanId, patch })`
* `backlog transition-status` $\rightarrow$ `backlog_update({ humanId, status, opts })`
* `backlog resolve-item` $\rightarrow$ `backlog_update({ humanId, status: "resolved", opts })`
* `backlog set-priority` $\rightarrow$ `backlog_update({ humanId, patch: { priority } })`
* `backlog assign-item` $\rightarrow$ `backlog_update({ humanId, assignedTo: to })`
* `backlog start-work` $\rightarrow$ `backlog_update({ humanId, status: "in_progress" })`
* `backlog claim-item` $\rightarrow$ `backlog_update({ humanId, claim: "claim" })`
* `backlog release-claim` $\rightarrow$ `backlog_update({ humanId, claim: "release" })`
* `backlog renew-claim` $\rightarrow$ `backlog_update({ humanId, claim: "renew" })`
* `backlog append-note` $\rightarrow$ `backlog_update({ humanId, addNote: text })`
* `backlog add-citation` $\rightarrow$ `backlog_update({ humanId, addCitation: citation })`
* `backlog soft-delete-item` $\rightarrow$ `backlog_update({ humanId, softDeleteReason: reason })`

---

### 5. `backlog_relate` (4 original commands)

Handles linking, graph associations, and plans.

* `backlog add-dependency` $\rightarrow$ `backlog_relate({ sourceId, targetId, relation: "dependency", action: "add" })`
* `backlog remove-dependency` $\rightarrow$ `backlog_relate({ sourceId, targetId, relation: "dependency", action: "remove" })`
* `backlog link-related` $\rightarrow$ `backlog_relate({ sourceId: humanIdA, targetId: humanIdB, relation: "related", action: "add" })`
* `backlog attach-to-plan` $\rightarrow$ `backlog_relate({ sourceId, targetId: planSlug, relation: "plan", action: "add" })`

---

### 6. `backlog_admin` (9 original commands)

Isolates bulk, maintenance, serialization, and system operations.

* `backlog archive-resolved` $\rightarrow$ `backlog_admin({ action: "archive", params: { scope, opts } })`
* `backlog export-json` $\rightarrow$ `backlog_admin({ action: "export", params: { filter } })`
* `backlog import-from-markdown` $\rightarrow$ `backlog_admin({ action: "import", params: { input } })`
* `backlog render-to-markdown` $\rightarrow$ `backlog_admin({ action: "render_markdown", params: { filter } })`
* `backlog merge-items` $\rightarrow$ `backlog_admin({ action: "merge", params: { keepHumanId, dropHumanId, reason } })`
* `backlog migration-status` $\rightarrow$ `backlog_admin({ action: "migration_status" })`
* `backlog set-migration-phase` $\rightarrow$ `backlog_admin({ action: "set_migration_phase", params: { phase } })`
* `backlog stale-claims` $\rightarrow$ `backlog_admin({ action: "stale_claims", params: { maxAgeMin, scope } })`
* `backlog stats` $\rightarrow$ `backlog_admin({ action: "stats", params: { scope } })`

---

### Consolidation Summary

| New Consolidated Tool | Original Commands Count | Reduction % | Primary Purpose |
| --- | --- | --- | --- |
| `backlog_get` | 3 | **66%** | Single item inspection |
| `backlog_query` | 5 | **80%** | Multi-item search & views |
| `backlog_create` | 3 | **66%** | Instantiation & variants |
| `backlog_update` | 12 | **91%** | All state, field, & claim mutations |
| `backlog_relate` | 4 | **75%** | Relational link management |
| `backlog_admin` | 9 | **88%** | Maintenance & system utilities |
| **Total** | **36 Commands** $\rightarrow$ **6 Tools** | **83% Total Reduction** | **Massive Context & Latency Savings** |

*(Note: `repo` and `by` fields previously present across 24 commands are now extracted directly from session context).*

---
