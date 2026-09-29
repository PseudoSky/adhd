# UNRESOLVED — Actionable Store Demo

Interfaces the demo had to guess, and scope gaps found while authoring.
**Revision 3:** every former ⟦U#⟧ stub is **PINNED** to the shipped build
(`entrypoint/backlog/dist/api.d.ts`, the CLI `--help`, and live runs against
`entrypoint/backlog/dist/index.js`). The `DEMO.md` beats were corrected to
match. This revision adds the DESIGN §3 refusal negative controls (R1–R7), the
revision-counter and batch-gating beats, a tightened sibling-repo fixture, and
the §2.3 spec-vs-shipped contradictions. Nothing below is a guess; each pinned
row cites what confirmed it.

The remaining unresolved items are **scope gaps** (see §2.2 and §4) and one
**spec-vs-shipped contradiction** recorded but not resolved (§2.3). The two
former defect beats (2.4, 3.3) are now **FIXED and running** (see §2.1).

## 1 · Pinned interfaces (were ⟦U#⟧)

| ID | Formerly guessed | **Pinned shipped shape** | Confirmed by |
|---|---|---|---|
| U1 | `serve` readiness probe | `adhd-backlog serve --probe` runs the serving-path probe once and prints `{"state":"ready","since":"⟨iso⟩","degraded":false}`, exit 0 (ready) / 1 (not ready). `--ready-file <path>` writes the same report atomically. Drives the mounted `embedding-status` op through the real composed invoker. | `src/readiness.ts`; `serve --help`; live run |
| U2 | `attest`/`recheck` JSON | `IAttestInput` `{subject:{id,revision},claim:{kind,body?},anchor:{locator,digest},by}` → `IAttestOutcome` `{attestationUid,subject,check}`. `check` = `{state,method,checked_at,checked_by,reason?}`; `state ∈ unverified\|verified\|stale\|unknown`; `method ∈ exists_at_head\|changed_since\|full_resolve\|none\|default_branch_ancestor`. `recheck` → `{attestationUid,checks[]}` (append-only). **`anchor.locator` requires a scheme prefix** (`path:`/`url:`/`query:`/`registry:`/`commit:`/`revision:`); a bare path is `invalid_argument`. `registry:`/`url:`/`query:` are `unverified` (no checker wired). | `dist/write/attestation.d.ts`, `dist/write/anchor-check.d.ts`; live runs |
| U3 | `obligate` JSON | `{uid,applies_to:{to,from?},requirement,on_fail:'block'\|'warn',override?,by}` → `{uid,obligationUid}`. The predicate is the closed core and **`evidence` is flat**: `{op:"evidence",kind,min?}` (NOT `{evidence:{…}}`). `applies_to.to` is required. | `dist/write/obligation.d.ts`; live runs |
| U5 | `soxe verify --host <host>` | **No such command.** `soxe` exposes `validate [path]` (validates `extension.json`) but no artifact-drift `verify`; D-B is unimplemented. | `soxe --help`; `soxe verify` → `sox: unknown verb 'verify'` |
| U6 | `query {view:"catalogs"}` | `data.terms[]` (flat), each `{name,uid?,catalog,source,lifecycle,replacedBy?,usageCount?}`. NOT `data.catalogs.kind.terms`. `view:"kinds"` returns `{catalogs:CatalogKindName[],terms,hasCaseCollisions}`. | `dist/query/views/catalog.d.ts`; `src/query/query.ts` dispatch; live run |
| U7 | `filter.similarTo` + reviewed link | Confirmed: filter `similarTo`/`hasSimilar`, reviewed relation `similar_to` via the existing `relate` verb, `duplicate_of` reserved. `view:"similar"` returns `{view,items[…],clusters?}` where `items` are `IIssueCard[]`; the cluster block is additive. **Needs the embedding backend** — answers `invalid_argument` without it. | `dist/query/types.d.ts`; live run |
| U8 | `verdict` card projection | `{actionable, evaluated_at, revision, conditions[]}`; `actionable` is tri-state `true\|false\|"unknown"`; `ICondition` = `{type,status,severity,code,subject?,message?}` with **`status` a STRING** (`"True"\|"False"\|"Unknown"`), `type ∈ Blocked\|Obligation\|Evidence\|Claim\|Reference\|Budget`. An obligation-free item carries a `warn` `MissingObligation` condition. | `dist/query/types.d.ts`; live run |

## 2 · Beats carried as not-runnable

### 2.1 Product defects — FIXED (now running; assertions evaluated every run)

- **Beat 2.4 — sibling-repo citation false refutation. FIXED (`068e554c`).**
  `recheck` and `attest` resolved an anchor only against the **subject issue's
  single project path** (the dead symbol `resolveIssueProjectPath`); the anchor
  carries no project of its own, so a citation living in a sibling repo was
  probed against this repo and reported `stale`/`unknown`. `resolveIssueProject`
  now also returns the project uid, and the new `resolveAnchorRoot`
  (`write/attestation.ts`) probes the subject root first, then every other live
  registered project root, returning the first root whose work tree has the
  target present at HEAD. The beat runs and reads `verified`; reverting the fix
  makes the runner exit 1. The fixture seeds a **genuine second registered
  project** — a real git work tree at `tmp/actionable-store-demo/sibling-repo/`
  (its own `.git`), registered via `upsert-project` — so the beat can assert the
  anchor is **absent from THIS repo's HEAD** (`git cat-file -e HEAD:<rel>`
  fails) and resolves `verified`/`changed_since` against the sibling root, not a
  same-repo file.
- **Beat 3.3 — a terminal-scoped `block` obligation made the item unclaimable.
  FIXED (`5db10040`).** `write/gate.ts` `evaluateVerdictTx` evaluated a
  terminal-scoped obligation (`applies_to.to:"closed"`) and reported
  `actionable:false`, so `claim` refused work that was merely obligated. It now
  applies the SAME `predictsClose` skip its close gate uses; the close itself
  stays refused by the same obligation. The beat runs; reverting the fix makes
  the runner exit 1.

### 2.2 Environment / scope (not defects in this build)

- **Beat 5.1 — NOW-RUNNABLE (residual scope gap).** The runner no longer
  discards the beat's assertion: the too-short refusal is evaluated each run
  and holds (`invalid_argument`). A genuine `ambiguous_reference` still needs
  two live nodes sharing an 8-hex prefix; the demo's example `4fc` is 3 chars,
  below `MIN_UID_PREFIX_LENGTH` (8), and `write/tx.ts` mints
  `crypto.randomUUID()` with no override, so the isolated fixture cannot seed
  one deterministically. That residual keeps REQ-001 partial.
- **Beats 5.4 / 5.6 — need the semantic/embedding backend.** The demo fixture
  runs `embedding.enabled:false` for determinism (and
  `@adhd/sox-embedding-provider` is an optional dependency not in the default
  install); with it off, `filter.semantic` and `view:"similar"` answer
  `invalid_argument "semantic search is not configured"`. Run against an
  embeddings-enabled store.
- **Beat 5.7 — D-B `verify` unimplemented.** No `soxe verify` verb exists; the
  D-B artifact-lifecycle check is specified under `substrate-fleet/specs/` but
  not implemented.

### 2.3 Spec-vs-shipped contradictions (recorded, not resolved)

- **The `revision` bump list — DESIGN §2 P4 / C6 spec vs the shipped build.**
  The C6 spec (`C6-verdict.spec.md:74-79`, `write/revision.ts`) lists
  `obligate` / `unobligate` among the writers that set `meta.revision =
  nextRevision(priorMeta)`, and DESIGN §2 P4 says the counter is "bumped on
  every mutating write". In the SHIPPED build (measured this session via
  `get fields:["verdict"]` → `verdict.revision`): `update` (in-place),
  `transition`, `claim`/`release`, `relate` (as source) and `move` each bump by
  exactly **+1**, and a body edit **supersedes** to a new node at `prior + 1` —
  but `obligate`, `unobligate` and `attest` do **NOT** bump. `attest` not bumping
  is consistent with the spec (it never touches the subject); whether
  `obligate`/`unobligate` *should* bump is an **open design question**. Beat 3.5
  asserts the verbs that DO bump and makes **no assertion either way** about the
  three, so the contradiction is recorded here rather than baked into a test.

## 3 · Corrected shipped-shape facts (were wrong in DEMO.md rev 1)

- **`get` field for the spec pointer is `fields:["spec"]`,** and the card
  carries it under **`data.spec.{spec_revision,spec_revision_token,revision_seq,freshness?}`** —
  not a top-level `spec_revision`.
- **`view:"order"` returns `data.order` as an object** `{ok:true,order:[…]}` or
  `{ok:false,cycle:[…]}` — never a bare array, and **carries no `meta`**.
- **Item-list views carry `meta.has_more`** (+ `total`,`returned`,`limit`,
  `total_relation`); **`meta.truncated` does not exist on them** (it is set
  only by the ranked `grep`/`semantic` path).
- **`transition` outcome is `{uid,fromStatus,toStatus,closedAt?,transitionUid}`** —
  there is **no `satisfiedBy` field** on the wire; the `satisfies` edges are
  written but the internal `meta.satisfied_by` is not surfaced on the result.
- **`*_kind` fields are snake_case in the structured refusal** (`required_kind`,
  not `requiredKind`), and the closure gate refuses `block` obligations with
  `EvidenceUnverified` only when zero **mechanically verified** attestations of
  the required kind exist. A mechanically-verifiable anchor is required:
  `path:` (present at HEAD) or `commit:` (ancestor of the default branch);
  `registry:`/`url:`/`query:` can never satisfy.
- **The CLI drops the structured `error.details.refusal`** computed by
  `api.ts`/`toEnvelope` — only `details.retryable` reaches stdout. The refusal
  reason survives in `error.message`. (The assertion keys on the message.)
- **A sub-8-character uid prefix is `invalid_argument`** ("too short"), not
  `ambiguous_reference`; an unmatched 8-char prefix is `item_not_found`.
- **An anchor `digest` is BARE sha256 hex** (64 chars, no `sha256:` prefix).
  `anchor-check.ts`'s full-resolve rung compares it byte-for-byte against
  `createHash('sha256').update(HEAD blob).digest('hex')` without stripping a
  prefix, so a `sha256:<hex>` digest can never match and always resolves
  `stale` at that rung. The demo shows the bare form; beat 2.5 proves it with a
  real digest (verified) and a wrong digest (stale). (The `sha256:⟨hex⟩`
  shorthand in earlier revisions was illustrative but NOT wire-correct.)
- **A cross-repo `path:` anchor resolves against its OWN registered project
  root.** `recheck`/`attest` probe the subject root first, then every other
  live registered project root. The candidate set is the same registry source
  `createIssue`/`transition` use for their own cross-repo citation probe — not
  a second path-resolution mechanism. Beat 2.4/2.5 prove it; reverting
  `resolveAnchorRoot` to subject-root-only makes them go red.

## 4 · Scope gaps & open questions

- **D-A / D-B / D-C** have interface specs under `substrate-fleet/specs/`
  (`D-A-service-trust.spec.md`, `D-B-artifact-lifecycle.spec.md`,
  `D-C-knowledge-layer.spec.md`). Beat 5.7 depends on D-B, which is
  unimplemented in sox-ecosystem.
- **Wave-1 vs Wave-2 split.** Acts 1–2 map to Wave 1 (C1, C2 kind-scope, C6
  structural, C7); Acts 3–4 exercise C3/C4/C5 (attestation, obligation,
  closure gate), which the adversarial reviews moved to Wave 2. The sign-off
  must record which wave was actually built.
- **The demo's `satisfies`-edge visibility** is internal; a consumer asking
  "which attestation satisfied which obligation?" must read the item's
  obligations/attestations, not the transition outcome. Surfacing it is a
  candidate enhancement.
- **C9 cross-project provenance** (beat 5.6) is only demonstrable with the
  embedding backend configured; `filter.similarTo` alone is a reviewed-link
  filter and still routes through the vector space on `view:"similar"`.
- **C2 kind-scope in `view:"order"`** (beat 1.3) — the production store's plan
  carried non-`issue` bucket rows as `part_of` members, which is what the
  "order includes non-issue members" clause proved. The isolated fixture
  creates only `issue` plan members (the shipped `relate` verb links
  issue→issue `part_of`), so that clause cannot be reproduced here and is
  recorded as a scope gap, not silently dropped.
- **The `STAGE`-kind refusal is a design-level absence, not a mint refusal**
  (beat R6). The store's `kind` vocabulary is **open**, so a user can mint an
  arbitrary label named `STAGE`; what the design refuses (`DESIGN.md:126`) and
  what R6 proves is that no **stage primitive** exists — no stage field is
  accepted, the shipped kind catalog carries no stage term, and the governed
  vocabulary refuses the retired `EPIC` kind on mint. A stage is an obligation
  plus a derived verdict, not a primitive.
