# CLI-HIERARCHY — Consolidate `@adhd/backlog` onto an action-first verb tree

**Status:** TARGET design (spec artifact). Changes no behavior, writes nothing to the graph, ships no code. It is the interface-shape deliverable for the owner's verb-consolidation direction; execution is gated behind the superseding ADR in §8.
**Owner:** pseudosky.
**Directed by:** the owner, verbatim: *"i want the hyphenated top level verbs consolidated into logical locations, if they are crud operations they should live on the crud verbs the cli should be action based at the top level absolutely not including domain level objects like project. establish a clear hierarchy maybe backlog `<verb> <subject> [action options and input]`"*.
**Grounding:** `docs/decisions/0006-backlog-public-interface-freeze.md` (the CURRENT 29 verbs + `batch action`, one-`--input` convention, ten error codes, kebab/snake/scoped naming, CLOSED `rel` union); `docs/plan/backlog-consolidation/backlog-interface-target.md` (target deltas); `docs/plan/backlog-consolidation/SPEC-SET.md` (S01–S12 + implied verbs); `entrypoint/backlog/src/api.ts` (the exported functions ARE the mounted surface).
**Relationship to ADR-0006:** this design is **BREAKING** against the frozen surface. It is proposed as a superseding ADR (§8); `docs/decisions/0006-*` is **not** edited here.

---

## Principle & grammar

The surface is **action-first**. The **first token after `backlog` is always an action verb** — a CRUD verb or a domain action. A **domain noun is never a top-level verb**; it is only ever a **subject** (the second token) or an input field. This is the whole point of the change: today `upsert-project`, `rm-project`, `merge-project`, `add-citation`, `priority-matrix` bake a domain noun into the top-level verb; the target hoists the action and demotes the noun to a subject.

**Grammar (resolved):** `backlog <verb> <subject> [action-options and --input '<json>']`

- `<verb>` ∈ the closed top-level action set: `create`, `get`, `list`, `search`, `update`, `delete`, `claim`, `transition`, `move`, `merge`, `relate`, `attest`, `obligate`, `report`, `resolve`, `inspect`, `batch`.
- `<subject>` ∈ a domain noun (`issue`, `project`, `component`, `location`, `citation`, `attestation`, `obligation`, `spec`, `state`, `session`, `kind`, `duplicate`, `reservation`, `collision`, `registry`, `embedding`). Subjects are **not** restricted; only the top level is.
- The verb may be given with or without its leading `backlog` segment (`create issue` ≡ `backlog create issue`), exactly as today.
- The **one-`--input` JSON envelope is unchanged**: the subject moves out of the verb name into a positional token; the payload is still exactly one `--input '<json>'` (or none, for `inspect embedding`). The hierarchy does NOT change the envelope.

**Ambiguity resolved — the read verb.** The owner named CRUD "create / read / update / delete — and list/search/get where read is distinct". The read umbrella is therefore realised as **three distinct top-level read verbs**, each an action, not a literal `read`:
- `get <subject>` — one record by uid (and the existing `{registry:…}` detail);
- `list <subject>` — a collection via filter / `view` / `groupBy` / pagination;
- `search <subject>` — text (`grep` / `semantic`) reads.

**Alternative rejected:** a single literal `read` verb multiplexed by `--one`/`--many`/`--text`. Rejected because it hides which shape the caller wants behind flags and because the owner's own exemplar grammar uses `list <subject>`, not `read <subject>`.

**Ambiguity resolved — verb/subject order.** Verb first, subject second (as the owner's grammar states). Alternative rejected: subject-first (`backlog project create`), which re-introduces the domain noun as the first token and defeats the principle.

---

## Consolidated tree

```
backlog
├── create <subject>            # CRUD create (existence-mutating, idempotent for registry subjects)
│   ├── issue                   # was `create`
│   ├── project                 # was `upsert-project`  (create-or-update, idempotent)
│   ├── component               # was `upsert-component`
│   ├── location                # was `upsert-location`
│   ├── citation                # was `add-citation`
│   ├── spec                    # was `spec-append`   (mints a new immutable spec revision)
│   └── state                   # was `state-append`  (S12 internal mint hook; not user-facing)
├── get <subject>               # CRUD read — one record
│   ├── issue                   # was `get` (bare)
│   ├── project|component|location   # was `get {registry:…}`
│   ├── citation
│   ├── attestation
│   ├── obligation
│   ├── spec                    # absorbs `spec-check` (`--token`) + B1 fragment read
│   ├── state                   # S12 state-revision read
│   └── session                 # S11 `timeline` (ordered op-events + records touched)
├── list <subject>              # CRUD read — a collection (filter / view / groupBy / page)
│   ├── issue                   # was `query`
│   ├── project|component|location
│   ├── citation                # B2: `--path <p>` citation-by-path enumeration
│   ├── attestation
│   ├── obligation
│   ├── kind                    # S06 readable catalog (was `get {registry:"kind"}`)
│   ├── duplicate               # S02 candidate duplicate clusters
│   ├── reservation             # S11 active reservations (store-wide)
│   ├── collision               # the `collisions` view
│   └── session                 # S11 session enumeration
├── search <subject>            # text read
│   └── issue                   # was `query --input '{"text":…}'`
├── update <subject>            # CRUD update (in-place; no uid mint)
│   ├── issue                   # was `update`
│   ├── project|component|location
│   ├── attestation
│   └── obligation
├── delete <subject>            # CRUD delete (bi-temporal soft delete; never hard delete)
│   ├── issue                   # was `delete`
│   ├── project                 # was `rm-project`
│   ├── component
│   ├── location                # was `rm-location`
│   └── citation                # was `remove-citation`
├── claim issue                 # --action acquire|renew|release  (lease state machine)
├── transition issue            # status state machine
├── move issue                  # re-file under a different component
├── merge <subject>             # project (was `merge-project`) | issue (B3 absorb/redirect)
├── relate issue                # add/remove a CLOSED-union rel edge; `link-duplicate` = rel duplicate_of
├── attest issue                # --action create|recheck  (absorbs `recheck`)
├── obligate issue              # --action declare|retire  (absorbs `unobligate`)
├── report issue                # --view summary|priority-matrix|part-of-rollup|open-curve
├── resolve registry            # was `lookup`
├── inspect embedding           # was `embedding-status` (process/config read, not a graph record)
└── batch                       # fan-out over the SAME tree (was namespaced `batch action`)
```

Every top-level token is an action. The domain-noun check: none of `create/get/list/search/update/delete/claim/transition/move/merge/relate/attest/obligate/report/resolve/inspect/batch` is a domain noun.

---

## Full mapping (old → new)

Every one of the 29 frozen verbs, the `batch action` mount, and the target/new verbs (S02, S04 B1/B2, S11, S12, `collisions`, S06 `kind`).

| # | current verb / mount | new hierarchical form | rationale |
|---|----------------------|-----------------------|-----------|
| 1 | `get` | `get <subject>` (`issue` \| `project` \| `component` \| `location`) | read-one; subject selects the record type (absorbs the `{registry:…}` branch) |
| 2 | `query` | `list issue` (+ `search issue` for `text:`) | read-many split into the collection read and the text read |
| 3 | `create` | `create issue` | CRUD create; issue is the subject |
| 4 | `update` | `update issue` | CRUD update |
| 5 | `transition` | `transition issue` | status state machine — action verb, not CRUD |
| 6 | `claim` | `claim issue` (`--action acquire\|renew\|release`) | lease state machine — action verb |
| 7 | `relate` | `relate issue` (add/remove; absorbs `link-duplicate`) | edge action enforcing the CLOSED union + cardinality |
| 8 | `delete` | `delete issue` | CRUD delete (soft) |
| 9 | `move` | `move issue` | re-file action — relational reassignment, not CRUD |
| 10 | `merge-project` | `merge project` | N→1 reconciliation — action verb, subject `project` |
| 11 | `rm-project` | `delete project` | CRUD delete, subject `project` |
| 12 | `upsert-project` | `create project` (idempotent create-or-update) | upsert is a CRUD create/update concern; subject `project` |
| 13 | `upsert-component` | `create component` | as #12, subject `component` |
| 14 | `upsert-location` | `create location` | as #12, subject `location` |
| 15 | `rm-location` | `delete location` | CRUD delete, subject `location` |
| 16 | `add-citation` | `create citation` | plain join-record create |
| 17 | `remove-citation` | `delete citation` | plain join-record soft delete |
| 18 | `spec-append` | `create spec` | mints a new immutable spec revision of the subject |
| 19 | `spec-check` | `get spec --token <t>` | a token/staleness read — belongs on the read verb |
| 20 | `attest` | `attest issue` (`--action create`) | verification action; the attestation is its artifact |
| 21 | `recheck` | `attest issue --action recheck` | re-verification — the same action's second mode |
| 22 | `obligate` | `obligate issue` (`--action declare`) | requirement-declaring action verb |
| 23 | `unobligate` | `obligate issue --action retire` | the inverse mode of the same action |
| 24 | `priority-matrix` | `report issue --view priority-matrix` | aggregate read folded onto the report action |
| 25 | `part-of-rollup` | `report issue --view part-of-rollup` | aggregate read folded onto the report action |
| 26 | `open-curve` | `report issue --view open-curve` | aggregate read folded onto the report action |
| 27 | `report` | `report issue` (`--view summary`, default) | the aggregate read action; the base form |
| 28 | `lookup` | `resolve registry` | free-text registry resolution — action verb |
| 29 | `embedding-status` | `inspect embedding` | process/config health read (not a graph record) |
| — | `batch action` mount | `batch` (fan-out over the same tree) | reserved top-level fan-out namespace; op id `backlog/batch` |
| N1 | `link-duplicate` (S02) | `relate issue --rel duplicate_of` | reviewed duplicate linking is `relate` with `duplicate_of` + `reason` |
| N2 | B1 spec-revision fragment read (S04) | `get spec --fragment` | closes the absent read-back path on the read verb |
| N3 | B2 citation-by-path (S04) | `list citation --path <p>` | "which items cite this path?" is a collection read |
| N4 | `reservations` view (S11) | `list reservation` | enumerable reservation read, subject `reservation` |
| N5 | `timeline <session>` (S11) | `get session <id>` (+ `list session` to enumerate) | a session's timeline is a read of the session |
| N6 | state-revision read (S12) | `get state --uid <plan>` | read the latest state revision + token/CAS status |
| N7 | `state-append` mint hook (S12) | `create state` (internal, same-tx hook; not user-facing) | revision mint is a create of the subject `state` |
| N8 | `collisions` view | `list collision` | the collision view is a collection read |
| N9 | kind catalog read (S06) | `list kind` | enumerate the readable, generated catalog terms |

**Removed/absorbed:** none removed outright. Every current verb is **renamed or absorbed**; `batch action` becomes `batch`. No capability is dropped.

---

## CRUD-ownership

**The CRUD verbs** own the plain record lifecycle. A subject belongs under CRUD when its record has a uid and a lifecycle expressible as create / read / update / delete:

- **`create`** — `issue`, `project`, `component`, `location`, `citation`, `spec` (a new spec revision), `state` (internal S12 mint). Registry subjects (`project`/`component`/`location`) keep their shipped **idempotent upsert** semantics: `create <registry-subject>` is create-or-update.
- **`get`** — the read-one form for every uid-addressable subject (`issue`, `project`, `component`, `location`, `citation`, `attestation`, `obligation`, `spec`, `state`, `session`); `spec --token` and `spec --fragment` are read modes.
- **`list`** — the read-many form (`issue`, `project`, `component`, `location`, `citation --path`, `attestation`, `obligation`, `kind`, `duplicate`, `reservation`, `collision`, `session`).
- **`search`** — the text read (`issue`).
- **`update`** — the in-place modify form (`issue`, `project`, `component`, `location`, `attestation`, `obligation`).
- **`delete`** — the bi-temporal soft-delete form (`issue`, `project`, `component`, `location`, `citation`).

**The action verbs** are NOT CRUD, for one of two reasons — each is either a **state machine over a record** or a **multi-record reconciliation**, not a record's own lifecycle:

| verb | why it is NOT CRUD |
|------|--------------------|
| `claim` | a **lease** state machine (acquire/renew/release) with a holder and expiry — no record lifecycle |
| `transition` | a **status** state machine, gated by C5 obligations/C6 verdict — not an edit |
| `move` | relational **reassignment** across components — changes the containment edge, not a field |
| `merge` | **N→1 reconciliation** (redirect row + soft-retire), addressability-preserving — not delete+create |
| `relate` | enforces the **CLOSED `rel` union** and n:1 cardinality (`part_of`/`supersedes`/`duplicate_of`) — a validated edge action |
| `attest` | a **verification action** with an anchor grammar and an append-only check history; `recheck` is its second mode |
| `obligate` | declares a typed requirement drawn from a **closed predicate core**; `retire` is its inverse mode |
| `report` | a **derived aggregate** over a population (matrix/rollup/curve/summary), keyed by no list cursor |
| `resolve` | **free-text resolution** to a registry entity — a lookup, not a record read |
| `inspect` | reads a **process/config property** (effective vs configured `embedding.*`), not a store record |
| `batch` | a **fan-out** transport over the whole verb set, not a domain operation |

**Alternative rejected:** routing `attest`/`obligate`/`relate` under `create attestation`/`create obligation`/`create relation`. Rejected because these records are artifacts of a validated domain action (anchor grammar, closed predicate core, closed rel union + cardinality), and the owner named `attest`/`obligate`/`relate` as genuine action verbs. A generic `create <subject>` would still branch on the subject to validate — renaming the branch does not remove it.

**Alternative rejected:** a literal `read` verb (see §1).

**Alternative rejected:** an `ensure <subject>` verb for the `upsert-*` trio. Rejected to keep the top-level CRUD surface minimal and because an upsert is a create/update concern.

---

## Classification

Measured against `adhd ADR-0006`. `additive` = permitted under ADR-0006 D6 with no sign-off; `breaking` = requires explicit owner sign-off **and** a superseding ADR of 0006 at ship time.

| move | class |
|------|-------|
| `get` → `get <subject>` (subject token added) | **breaking** (verb name/signature changes for most subjects; MCP/HTTP/routes change) |
| `query` → `list issue` / `search issue` | **breaking** (rename + split of one verb into two) |
| `create`/`update`/`delete` → `create/update/delete issue` | **breaking** (verb gains a required subject token; MCP/HTTP names change) |
| `upsert-project`/`-component`/`-location` → `create <subject>` | **breaking** (rename; three verbs → one) |
| `rm-project` → `delete project`; `rm-location` → `delete location` | **breaking** (rename) |
| `add-citation`/`remove-citation` → `create/delete citation` | **breaking** (rename) |
| `spec-append` → `create spec`; `spec-check` → `get spec --token` | **breaking** (rename + read/write re-home) |
| `attest`/`recheck` → `attest issue` (+`--action`) | **breaking** (recheck absorbed) |
| `obligate`/`unobligate` → `obligate issue` (+`--action`) | **breaking** (unobligate absorbed) |
| `priority-matrix`/`part-of-rollup`/`open-curve`/`report` → `report issue --view` | **breaking** (three verbs + one absorbed into one) |
| `merge-project` → `merge project`; `lookup` → `resolve registry`; `embedding-status` → `inspect embedding` | **breaking** (rename) |
| `batch action` → `batch` | **breaking** (mount name/op id change) |
| N1 `link-duplicate` → `relate issue --rel duplicate_of` | **breaking** as a mapping (the verb is not shipped, so its *arrival* is additive; its *canonical home* is `relate`) |
| N2–N9 (`get spec --fragment`, `list citation --path`, `list reservation`, `get session`, `get state`, `list collision`, `list kind`) | additive capabilities expressed through the new tree |
| envelope shape, ten error codes, `by` identity, one-`--input`, CLOSED `rel` union | **unchanged** |

**Net verdict: this is a BREAKING surface change.** It renames or re-homes essentially the entire 29-verb set and changes both the MCP `backlog_<verb>` naming scheme and the HTTP/OpenAPI paths. Under ADR-0006 D6 every such change requires **explicit owner sign-off** and a **superseding ADR of ADR-0006** at ship. The owner has directed it; the sign-off is recorded (§8) but the superseding ADR is proposed, not written, here.

---

## Skills are the contract

There is **no migration story** — the owner rejects one. The CLI verb surface is **consumed through the skill**, not through muscle memory, a deprecation window, or an alias shim. The skill is the documented contract; **updating it to the new hierarchy in the same change IS the complete migration.** No aliases, no retained legacy verbs, no backward-compatibility layer: the old hyphenated spellings cease to exist at the same commit that updates the skill.

**Files that document the command surface — all updated in the same change:**

| file | role | what changes in it |
|------|------|--------------------|
| `entrypoint/backlog/skill/SKILL.md` | the authoritative command-surface doc (the in-repo source; frontmatter `name: backlog-usage`) | §1 command surface: replace the 29-verb list with the action-first tree (§2 above); every worked example re-run against the new build; the `adhd-backlog --help` comparison lines re-stated; §2 MCP tool names → `backlog_<verb>_<subject>`; §7 registry reads → the `get`/`list`/`resolve` subjects; §8 `batch action` → `batch`. The one-`--input` convention text is unchanged. |
| `.opencode/skills/backlog/SKILL.md` | the repo-local **installed copy** of the same document (observed byte-identical, `name: backlog-usage`) | regenerated from `entrypoint/backlog/skill/SKILL.md`; kept identical. |
| the global install target (named by root `AGENTS.md` as `~/.claude/skills/backlog/SKILL.md`, written by `adhd-backlog install-skill`) | the machine-wide agent-facing copy | re-installed from the updated source in the same change — a stale global copy is exactly the failure mode the `install-skill` step exists to prevent. |

The linked, hand-copied surface docs the same change touches are `entrypoint/backlog/SPEC.md`, `entrypoint/backlog/DATA_MODEL.md`, and `entrypoint/backlog/README.md` (per SPEC-SET write-scope for surface changes); they are corrected in lockstep with the skill, not via a compatibility path.

**Generated surfaces regenerate — no compatibility layer.**

- **MCP tool names:** `backlog_<verb>` becomes **`backlog_<verb>_<subject>`** — e.g. `backlog_create_issue`, `backlog_list_issue`, `backlog_get_spec`, `backlog_claim_issue`, `backlog_merge_project`. Action modes ride on `--input` (e.g. `backlog_claim_issue` with `action:"renew"`). No alias tools are emitted; a host picks up the new tree on restart (its tool list is the server process's build).
- **HTTP routes / OpenAPI:** each path derives from the verb+subject (`/create/issue`, `/create/project`, `/report/issue`), regenerated from the same extraction (`api.ts` is the choke point); operation ids become `backlog/<verb>/<subject>`. No legacy path is retained.

**Not part of the migration question — unchanged:** the one-`--input '<json>'` JSON envelope (exactly one per invocation; mode-less reads take none) and the two-arm `{ok,data}` / `{ok:false,error}` envelope with its ten codes/exits; `by="${agentName}:${instanceId}"` on every mutating verb; the CLOSED six-member `rel` union (`relates_to, supersedes, blocks, duplicate_of, part_of, similar_to`); and the Turso/LibSQL parallel-process invariant (sox ADR-0012). The subject moves from the verb name into a positional token — it does **not** enter the JSON envelope.

---

## Consequences & acceptance criteria

**Consequences**

- The top level becomes a small, stable action vocabulary; domain nouns move to subjects, so adding a subject (e.g. a future `judgment` record) does not widen the top-level verb set.
- There is no compatibility layer: the old hyphenated spellings are gone at the same commit that updates the skill. The skill update is the whole migration (§6); MCP names, HTTP routes and the OpenAPI doc regenerate from the new surface.
- ADR-0006's frozen 29-verb surface is **superseded**; its envelope/error-code/naming-scheme axes are carried forward unchanged except for the kebab verb/spelling rule, which the hierarchy replaces.

**Acceptance criteria (binary, checkable)**

1. **No top-level verb is a domain noun.** The top-level set is exactly `{create, get, list, search, update, delete, claim, transition, move, merge, relate, attest, obligate, report, resolve, inspect, batch}`; none is in the domain-noun set `{issue, project, component, location, citation, relation, attestation, obligation, spec, state, session, kind, duplicate, reservation, collision, registry, embedding}`.
2. **Every CRUD op is reachable under create/get/list/search/update/delete** (every `create <subject>`, `get <subject>`, `list <subject>`, `search <subject>`, `update <subject>`, `delete <subject>` in §2 resolves to a mounted operation).
3. **Every old verb has a recorded mapping.** §3 lists all 29 frozen verbs + `batch action`, each with a new form (or an explicit "removed/absorbed"); no row is blank.
4. **Every target/new verb has a home.** `link-duplicate`, B1 fragment read, B2 citation-by-path, `reservations`, `timeline`, state-revision read, `collisions`, and the `kind` catalog each appear in §2/§3.
5. **The envelope is unchanged.** Exactly one `--input '<json>'` per invocation (except the mode-less `inspect embedding`); a per-field flag is still rejected with `invalid_argument` (exit 2).
6. **`by` is unchanged** — every mutating verb still requires `"${agentName}:${instanceId}"`; a missing/blank `by` is still `invalid_argument`.
7. **The `rel` union is unchanged** — the six-member CLOSED union, with `part_of`/`supersedes`/`duplicate_of` single-valued; the hierarchy does not open it.
8. **The parallel-process invariant is intact** — no part of this design assumes single-writer (sox ADR-0012).
9. **No domain noun is a first token** in the tree in §2 (grep the tree's first tokens against criterion 1's noun set).
10. **This artifact** contains all eight required sections (`rg -c '^## '` ≥ 8).
11. **The skill is updated in the same change; no alias is emitted.** `entrypoint/backlog/skill/SKILL.md` (and its installed copies) document the new hierarchy at the same commit; the old hyphenated spellings are absent from the surface and from every generated transport — no alias tool, route, or verb survives the change.

---

## Superseding-ADR proposal

> **Proposed; not written to the catalog.** Per the ADR-catalog rule ("propose before write"), this block is a proposal only. The file `docs/decisions/000N-…` is created **only after explicit owner approval**, together with `adhd ADR-0006`'s updated Status line.

```
# ADR-0007 — Consolidate @adhd/backlog onto an action-first verb hierarchy
                          (supersedes ADR-0006)

Status:  PROPOSED
Owner:   pseudosky
Supersedes: adhd ADR-0006 (backlog public interface freeze)
Directed by: the owner (verbatim direction recorded — see CLI-HIERARCHY.md)
Drives:  docs/plan/backlog-consolidation/CLI-HIERARCHY.md

TL;DR for the next agent
  ADR-0006 freezes a 29-verb surface whose top-level verbs bake in domain nouns
  (upsert-project, rm-project, merge-project, add-citation, priority-matrix, …).
  The owner directed their consolidation onto an action-first hierarchy:
  `backlog <verb> <subject> [opts]`. CRUD lives on create/get/list/search/
  update/delete; claim/transition/move/merge/relate/attest/obligate/report/
  resolve/inspect/batch are the genuinely non-CRUD action verbs. No top-level
  verb names a domain noun. This is a BREAKING change to the 29-verb surface
  (ADR-0006 D6) and therefore requires explicit owner sign-off — it is NOT a
  silent refactor.

Context
  The hyphenated top-level verbs encode domain nouns; the owner wants an
  action-first hierarchy with a clear, small top level. The full mapping, tree,
  CRUD-ownership rules, classification, and the skill-update contract are the
  companion design artifact CLI-HIERARCHY.md.

Decision (numbered)
  D1. Top-level tokens are actions only; domain nouns are subjects, never verbs.
  D2. Grammar: `backlog <verb> <subject> [action-options and --input]`; the
      one-`--input` JSON envelope is unchanged; the subject is a positional token.
  D3. CRUD verbs: create, get, list, search, update, delete. Read is realised as
      get (one) / list (many) / search (text); no literal `read` verb.
  D4. Action verbs: claim, transition, move, merge, relate, attest, obligate,
      report, resolve, inspect; batch is the reserved fan-out namespace.
  D5. Every current verb has a recorded mapping (CLI-HIERARCHY.md §3); none is
      removed outright.
  D6. MCP names become backlog_<verb>_<subject>; HTTP paths and OpenAPI operation
      ids derive from the same path. The envelope, the ten error codes, the `by`
      identity rule, the CLOSED `rel` union, and sox ADR-0012 are unchanged.
  D7. No migration shim: the skill (entrypoint/backlog/skill/SKILL.md and its
      installed copies) is updated to the new hierarchy in the same change; no
      aliases and no legacy verbs are retained. MCP names, HTTP routes and the
      OpenAPI doc regenerate from the new surface.
  D8. This ADR supersedes ADR-0006 at ship; ADR-0006's Status line becomes
      "SUPERSEDED BY ADR-0007". ADR-0006 is never edited in place.

Evidence
  docs/decisions/0006-backlog-public-interface-freeze.md (the superseded surface);
  docs/plan/backlog-consolidation/CLI-HIERARCHY.md (full mapping + tree);
  docs/plan/backlog-consolidation/backlog-interface-target.md (target deltas);
  docs/plan/backlog-consolidation/SPEC-SET.md (S01–S12);
  entrypoint/backlog/src/api.ts (the extraction surface).
```

**Numbering note (resolved):** the catalog's next free number is **0007** (max on disk = 0006). `docs/plan/backlog-consolidation/backlog-interface-target.md` informally calls *itself* "target ADR-0007"; that file is not a catalog entry. Resolution: whichever of the two proposals is accepted first takes 0007; the other takes 0008. This artifact proposes **0007** per the catalog rule and flags the contention rather than silently colliding.
