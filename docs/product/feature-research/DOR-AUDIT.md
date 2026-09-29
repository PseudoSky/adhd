# DOR-AUDIT — Definition of Ready, applied to this project

> The project's own thesis is that an item must **declare what satisfies it**. This audit applies that standard to the project itself: twelve core tickets under umbrella `ee299cd5-016a-4778-a66f-ed8220e9e84d`, each with a spec under `actionable-store/specs/` or `substrate-fleet/specs/`.

## 1. The Definition of Ready

An item is **Ready** when all seven hold:

| # | Criterion | How it is evidenced |
|---|---|---|
| 1 | **Scope stated** | the ticket body's Problem + Change |
| 2 | **Acceptance criteria, each with a negative control** | the ticket's AC list + the spec's test table |
| 3 | **Evidence requirement declared** | the spec's `## DoR` header — *what proof closes it* |
| 4 | **Dependencies resolved** | no non-terminal `blocks` blocker, or the blocker is legitimately scheduled ahead |
| 5 | **A file/symbol-level spec** | the spec file, with symbol citations (never bare line numbers) |
| 6 | **Release wave** | the spec's `## DoR` header |
| 7 | **Owner repo** | the spec's `## DoR` header |

**Two readings, stated because they differ.** Judged on **ticket bodies alone**, 0 of 12 are Ready — no body declares an evidence requirement or a wave. Judged on **body + spec together** (the operative reading: the spec is the grounding artifact), **5 of 12 are Ready**. The gap is real either way: the *bodies* are behind the *specs*, and the bodies cannot be corrected in place (§4).

## 2. The matrix

| Ticket | 1 scope | 2 AC+neg | 3 evidence | 4 deps | 5 spec | 6 wave | 7 repo | Ready? |
|---|---|---|---|---|---|---|---|---|
| **C1** Reference | ✅ | ✅ | ✅ | ✅ none | ✅ | ✅ 1 | adhd | **✅ Ready** |
| **C2** Legibility | ✅ | ✅ | ✅ | ⚠️ body line stale | ✅ | ✅ 1 | adhd | ⚠️ one-line delta |
| **C3** Attestation | ✅ | ✅ | ✅ | ⚠️ C1 open | ✅ | ✅ 2 | adhd | ⏳ Wave 2 |
| **C4** Obligation | ✅ | ✅ | ✅ | ⏳ C3 open | ✅ | ✅ 2 | adhd | ⏳ Wave 2 |
| **C5** Closure gate | ✅ | ✅ | ✅ | ⏳ C3, C4 open | ✅ | ✅ 2 | adhd | ⏳ Wave 2 |
| **C6** Verdict | ✅ | ✅ | ✅ | ⏳ C4 open | ✅ | ⚠️ split 1/2 | adhd | ⏳ Wave 2 |
| **C7** Envelopes | ✅ | ✅ | ✅ | ✅ none | ✅ | ✅ 1 | adhd | **✅ Ready** |
| **C8** Vocabulary | ✅ | ✅ | ✅ | ✅ none | ✅ | ✅ 3 | adhd | **✅ Ready** |
| **C9** Similarity | ✅ | ✅ | ✅ | ⏳ C1 open | ✅ | ✅ 3 | adhd | ⏳ Wave 3 + rename delta |
| **D-A** Service trust | ✅ | ✅ | ✅ | ✅ none | ✅ | ⚠️ assigned Wave 4 | cross-plane | **✅ Ready** |
| **D-B** Artifact lifecycle | ✅ | ✅ | ✅ | ✅ none | ✅ | ⚠️ assigned Wave 4 | sox + claude-agents | **✅ Ready** |
| **D-C** Knowledge layer | ✅ | ✅ | ✅ | ⛔ sox SR-7/SR-9 | ✅ | ✅ 4 | sox | ⛔ blocked upstream |

**Strictly Ready: 5** — C1, C7, C8, D-A, D-B.
**Pending with cause: 6** — C2 (delta), C3/C4/C5/C6/C9 (their blockers are *legitimately open* — this is the dependency graph working, not a defect).
**Blocked upstream: 1** — D-C on substrate work (SR-7, SR-9) that has not started.

**The genuine gaps** (as opposed to correct dependencies):
1. **D-A, D-B, D-C had no wave.** The pass-2 design assigned no waves. Resolved here: all three are **Wave 4 (substrate)**, and the `## DoR` headers now say so.
2. **C2's body carries a stale dependency line** while the real `C1 blocks C2` edge exists — a body/spec divergence.
3. **Every ticket body is behind its spec** — criterion 3 (evidence requirement) and 6 (wave) exist only in the specs.

## 3. Contradictions found and corrected

| Finding | Correction |
|---|---|
| The dedupe concept was named **duplicate**; the scan detects **similarity**, and `link-duplicate` is not a verb | Renamed throughout: scan surfaces **similar** candidates; reviewed links use the **existing `relate`** verb with a new **`similar_to`** relation; card field `similar`; filters `similarTo`/`hasSimilar`; aligned with the **existing `view:"similar"`**. `duplicate_of` is **reserved** for the reviewed actual-same judgement. Spec renamed to `C9-similarity.spec.md`. |
| `applies_to.to` was optional (a silent dual) | Made **REQUIRED** (C4/C5 specs + design §2 P3). |
| `actionable` was a boolean; `Unknown` risked reading as green | Made **tri-state**; `unknown` is never green; list and `get` must agree (C6). |
| C2's `IIssueRef.rel` union omitted `duplicate_of`/`similar_to` | Widened. |
| `REFUTES` used without its dependency | Dependency on **sox ADR-0010 D3** (offline migration) now stated in SR-5 and D-C. |
| The fixed-`.tmp` race was attributed to **one** site | Corrected to **two**: `ownership.ts` **and** `install.ts`. |
| D-A's verify-after-write AC read as an adhd obligation | Declared a **sox/provider** requirement, unsatisfiable from adhd (SR-8, D-A spec). |
| ADR-0007's single-writer claim could be reasoned from | Struck; **ADR-0012 supersedes it** and is the binding invariant. |
| `resolveLogicalIssue` / `resolveLogicalIssueId` were two names for one thing | Reconciled to one implementation across C1/C3. |
| `IIssuePseudoField` widened in more than one spec independently | Pinned to one canonical union (C4/C6). |
| Bare `file:line` citations across all specs and design docs | Converted to **symbol** citations — a line number rots on every edit, the exact failure the attestation design exists to fix. |

## 4. Ticket-body deltas — cannot be applied in place

`update` with a `body` **supersedes the node and mints a new uid**, breaking every reference the fleet holds (no in-place annotate verb exists — defect `5b555754`, whose fix is C3). These changes are therefore **recorded, not applied**. Apply them once C3 lands, or accept the uid churn deliberately.

| Ticket | Delta | Impact |
|---|---|---|
| **C9** `cf97c613-2c0a-4f1b-805e-4fe773743c31` | Title and body still say *duplicate detection*, `link-duplicate`, `duplicates`/`duplicateOf`/`hasDuplicates`. Replace with **similarity**: `similar` card field, `similarTo`/`hasSimilar` filters, reviewed link via `relate {rel:"similar_to"}`, `duplicate_of` reserved. | **HIGH — the title itself is now wrong.** |
| **C4** `1c53784d-4d9e-4f85-b0f3-5199a8f7ea79` | Body shows `applies_to:{from?,to}` optional → `to` **required**. | MEDIUM |
| **C6** `291263ea-3bc9-41e2-a156-6fef72b88f22` | Body predates the **tri-state** `actionable` and the Wave-1/Wave-2 split. | MEDIUM |
| **C5** `b076742d-664d-467c-990d-2e11d82b4f45` | Reflect `to` required + the sox/provider split. | LOW |
| **C2** `ac911229-4530-4406-a43a-fbfe97fa3824` | Stale dependency line vs the real `C1 blocks C2` edge. | LOW |
| **D-A** `4503046c-91fe-4bd5-948d-bc594e7f6598` | AC5 declared a sox requirement, not an adhd one. | LOW |

**Count: 7 deltas (C10 added in §6); highest impact — C9's title, because a wrong noun propagates into every downstream reference.**

## 5. What would make this project Ready end-to-end

1. **Apply the seven body deltas** (blocked on C3's annotate verb, or a deliberate churn).
2. **Start Wave 1** — C1, C7, and C2's kind-scope half are dependency-free and Ready now.
3. **Open the substrate requirements** — D-C is blocked on sox SR-7/SR-9; those are requirements (`SOX-REQUIREMENTS.md`), assumed achievable, and are the only upstream block in the set.
4. **Give the epic an adoption metric** (filed `c022a921`) — the DoR is satisfied, but DoR is readiness, not success; the project still cannot say whether it worked.

## 6. C10 ticket-body delta — recorded, not applied

**C10's body is stale.** It describes the **sibling-SPEC model**: a `SPEC` item written as an *independent* item `part_of` its work item, with its own body carrying the contract block and an anchor. The corrected, researched model is **two ids + one pointer** — a spec is a **revision of its ticket**, not a sibling beside it. The authoritative statement is `actionable-store/specs/C10-store-citizen-documents.spec.md`; DESIGN §12 was rewritten to match.

| Ticket | Delta | Impact |
|---|---|---|
| **C10** `b009396b-5c05-4ed1-9f6a-f7d5bb7e0497` | The body's Problem/Change still say the spec is an independent sibling item. Replace with the two-ids-plus-pointer model: the work item's `uid` is the spec's **stable logical id**; each edit mints an **immutable revision object** (`kind: SPEC`); the work item holds a single mutable **`spec_revision` pointer** (never the text inline); staleness is token → content-hash → ancestry, with **an absent token = stale**; annotation is a separate record keyed to the revision; the twelve existing `SPEC` items are reconciled as the **current-revision objects** of their tickets (one current revision each). The body's AC1–AC7 are superseded by the spec's AC1–AC8. | **HIGH — the body now describes a superseded model; the noun "sibling spec" is wrong.** |

This is a **ticket-body delta, not an in-place edit.** C10's body cannot be corrected where it sits, for the same reason the six deltas in §4 cannot: `update` with a `body` supersedes the node and mints a new uid, breaking every reference the fleet holds (no in-place annotate verb exists — defect `5b555754`, whose fix is C3). **Recorded here, not applied**; apply it once C3 lands, or accept the uid churn deliberately. (§4's count is therefore now **seven** deltas.)
