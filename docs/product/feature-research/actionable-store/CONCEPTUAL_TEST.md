# CONCEPTUAL TEST — Actionable Store

Written walk-through against the real member items of `cf64c988` (14) and `1e61f827` (20), plus a demo script that fails today and passes after. Those two plans are **2 of the umbrella's 8 member plans**; the umbrella `ee299cd5` has 63 descendants (61 open, 2 closed, read from `part-of-rollup`), and the other ~29 rows are out of scope.

> **Evidence discipline.** Every uid, title, kind, status and priority below was read from the store this session. Anything sourced from an *item body* (as opposed to the card) is marked **[asserted in body — not independently verified]**. Two source items (`08102d9a`, `260d6b34`) contradicted each other on `view:"order"`; the contradiction was resolved by reading `entrypoint/backlog/src/query/query.ts:832-887` (see §C).

## A. The dispatcher's session, today

A dispatcher is asked to advance plan `cf64c988` ("how work is filed, judged and closed").

1. `adhd-backlog backlog query --input '{"filter":{"plan":"cf64c988-1bd9-4618-a369-d4a30d5649c9"},"limit":40,"fields":["uid","title","kind","status","priority"]}'`
   → 14 rows. Statuses read this session: `4fc3704e`, `decda240`, `e5a790a7`, `3ec44b8c` are `IN_PROGRESS`; the other ten are `open`. Priority is HIGH or MEDIUM on every row — **a uniform priority is no priority.**

2. The dispatcher asks "which are actionable?" It calls `view:"ready"`. That view excludes items with a non-terminal incoming `blocks`, but it **returns raw open items and reports no meta** (`93eac07b` [asserted in body — not independently verified]). A truncated page is indistinguishable from a complete one. There is no statement of *why* each remaining item is considered ready.

3. It must now judge, per item, whether it is real work or a policy proposal. Nothing in the card distinguishes `416971f9` ("A blocked issue can be claimed…") from `6bfdda8a` ("backlog-operator definition advertises an `enrich` verb the tool does not implement") — both are `open`, `HIGH`/`medium`, and neither carries a requirement or any evidence.

4. It picks `4fc3704e` — `IN_PROGRESS`, HIGH, the title reads like shipped work. It has no way to tell whether the claim is live or abandoned: there is no liveness signal, and the item cannot report one. (The prior handoff item `8db42169-193d-4739-9d4e-333e18d498f4` believed the three `IN_PROGRESS` items were not actually in progress and was working from an incomplete count — read from the store this session, there are four.)

5. If it instead picks `416971f9`, `claim` succeeds even though `42b0dc25` is recorded as blocking four items **[asserted in body / auditTrail — not independently verified; `get {fields:["related","blockers"]}` on `42b0dc25` returns empty, which is itself consistent with the premise that outbound `blocks` is not surfaced]** — claim has no non-terminal-blocker precondition (`416971f9`).

6. Having done the work, it closes `4fc3704e` by `resolve` with a commit ref. **Accepted.** Nothing checks that the referenced change is on the default branch, let alone that any artifact shipped (`4fc3704e`, `0abc01ed`).

7. To record the verification it performed, it wants to attach evidence. `update` accepts `{uid,by,title?,body?,kind?,priority?,assignee?,author?,awaitEmbed?}` — **no citations, no gitContext** — and a body edit **supersedes the uid** (`5b555754`). The evidence becomes prose, and the item it describes gets a new identity.

8. Its citation of a sibling-repo path is probed against the wrong project root and **falsely REFUTED** (`78c96213`). Its citation of the tool's own skill file is **rejected outright** — the skill lives outside every registered project root (`05f16e2a`, `78c96213`).

9. Net result: the dispatcher advanced the plan by an amount it cannot state, on evidence it cannot attach, in an order it cannot justify, and the store cannot now tell anyone what happened.

## B. The dispatcher's session, after

1. Same query. The card now carries, per item, a **derived** `Verdict`:
   - `4fc3704e` → `{actionable:true, conditions:[]}`; its claim is visible with liveness, and an abandoned claim surfaces as a `ClaimStale` condition rather than silently reading `IN_PROGRESS`.
   - `416971f9` → `{actionable:false, conditions:[{type:"Blocked", status:True, severity:"block", code:"BlockedBy", subject:"42b0dc25-…", message:"blocked by an open item"}]}` (`status:True` = the item **IS** blocked).
   - The four `IN_PROGRESS` items (`4fc3704e`, `decda240`, `e5a790a7`, `3ec44b8c`) carry their claim state; nothing is inferred from a status word.

2. It asks the order. `view:"order"` now returns a Kahn order over **every** member kind in scope, not only `kind:'issue'` (the real defect behind `260d6b34`), and each item's **outbound `blocks` set and dependent count** are exposed (`08102d9a`). `42b0dc25` — which unblocks four items — sorts first among equals under the **transitive-dependent-count tiebreak** instead of sitting at index 556 **[the index is asserted in the body of `08102d9a` — not independently verified; the "four" is likewise unverified, and for the same reason: outbound `blocks` is not surfaced on a card]**.

3. It asks what may be worked on. Every row in the plan carries its `Verdict` with reasons. Because all five reasons carry a stable code and a subject pointer, "zero actionable" is never a dead end — it names the blocker to clear.

4. It claims `416971f9`. `claim` **fails loudly**: `precondition_failed {code:"BlockedBy", subject:"42b0dc25-…"}`. It does not silently take blocked work (`416971f9`, `b2e9b451` tool-side).

5. It works `4fc3704e`. Before it can transition it to a terminal state, the item's **obligation** must be satisfied. `4fc3704e` has no obligation today (§6 of the design: nothing is retro-required), so the dispatcher declares one during the session — `obligate {uid, requirement: evidence{kind:"published-artifact"}}`. A commit ref does **not** satisfy it. The transition is refused with `{code:"EvidenceUnverified", required_kind:"published-artifact"}` and the status is unchanged on re-read (`4fc3704e`, `0abc01ed`).

6. It attaches evidence with a new verb: `attest {subject:{id, revision}, claim, anchor:{locator, digest}}`. The uid is **unchanged**; the claim records the revision actually observed; a per-claim `check` returns `verified`. A sibling-repo anchor is resolved against the item's own project root and verifies instead of falsely refuting; a tool-skill anchor verifies once the install root is allowlisted (`5b555754`, `78c96213`, `05f16e2a`).

7. The retry of the terminal transition now succeeds, and the closure records *which* attestation satisfied *which* obligation (`4fc3704e`).

8. It reports status. The report's numbers were computed from the store at report time — because the store now returns labelled counts, so there is nothing to invent (`f3a055bb`, `2ff739f7`).

9. Net result: the same work, but the store can state what may be worked on, in what order, with what proof — and can answer "why not" for everything it excludes.

## C. The contradiction that had to be resolved first

`08102d9a` asserts `view:"order"` dependency-orders over `blocks` and is "verified and tested". `260d6b34` asserts it "does not surface `blocks` ordering" and returned none of six bucket uids. Both cannot be true of one revision.

**Resolved by reading the source** (`entrypoint/backlog/src/query/query.ts:832-887`): `queryOrder` **is** a real Kahn topological sort over `blocks` (`:850-886`), returning `{ok:true, order}` or `{ok:false, cycle}` — **but `:841` sets `nodeFilter.kind = 'issue'`**, so any member that is not `kind:'issue'` is excluded from the order. `08102d9a` is right about issues; `260d6b34` is right about non-issue members. The ticket is therefore **kind-scope**, not "ordering does not work" — which is why C2's acceptance criterion is "an order over every member kind scoped by the filter", not "make order work".

This is exactly the evidence rule: two confident tickets, both partly wrong, resolved by the source.

## D. Demo script — fails today, passes after

Run each against a built `adhd-backlog`. `TODAY` is the observed/asserted failure; `AFTER` is the acceptance-oracle.

```bash
B="adhd-backlog backlog"

# 1. Short reference (C1) — today NOTHING resolves an abbreviated uid.
$B get --input '{"uid":"4fc3704e"}'                       # TODAY: item_not_found
                                                          # AFTER: resolves 4fc3704e-56b0-4363-a1fe-ec8a51826f8b
$B get --input '{"uid":"4fc"}'                            # AFTER: explicit ambiguity listing candidates

# 2. Lookup routes by kind (C1) — today it searches only the location registry.
$B lookup --input '{"q":"adhd"}'                          # TODAY: not_found "location"
                                                          # AFTER: the project row, or a redirect to get/query

# 3. Kind catalog readable (C8) — today the catalog is write-only.
$B get --input '{"registry":"kind"}'                      # TODAY: rejected at the MCP schema boundary — `registry` must equal one of [project,component,location] (a transport-level oneOf failure, not a domain invalid_argument)
                                                          # AFTER: kinds with type + lifecycle + scope

# 4. Claim refuses blocked work (C6) — today a blocked item is claimable.
$B claim --input '{"uid":"416971f9-…","by":"dispatcher","action":"claim"}'
                                                          # TODAY: succeeds
                                                          # AFTER: precondition_failed {code:"BlockedBy",subject:"42b0dc25-…"}

# 5. Terminal transition needs satisfied obligations (C5) — today a commit ref closes it.
$B transition --input '{"uid":"4fc3704e-…","by":"dispatcher","toStatus":"RESOLVED","citations":[{"file":"x","lines":"1"}]}'
                                                          # TODAY: succeeds
                                                          # AFTER: refused {code:"EvidenceUnverified",required_kind:"published-artifact"},
                                                          #        status unchanged on re-read

# 6. Attach evidence without churning identity (C3) — today `update` supersedes the uid.
$B attest --input '{"subject":{"id":"4fc3704e-…","revision":"<sha>"},"claim":{"kind":"published-artifact"},"anchor":{"locator":"registry:pkg@ver","digest":"<hash>"}}'
                                                          # TODAY: no such verb; the available path (`update` body) mints a NEW uid
                                                          # AFTER: same uid; check.state = verified

# 7. Honest page (C7) — today ready/stale/similar return no meta.
$B query --input '{"view":"ready","limit":5}'
                                                          # TODAY: {view:"ready",items:[…5…]}  (truncation invisible)
                                                          # AFTER: {view:"ready",items:[…5…],
                                                          #         meta:{returned:5,has_more:true,next_cursor:"…",
                                                          #               total:{value:49,relation:"eq"}}}
                                                          # NOTE: extend the existing meta keys
                                                          # (total/returned/limit/offset?/truncated? — query/meta-wire.e2e.ts);
                                                          # do NOT replace `truncated`, consumers key on it.

# 8. Score provenance (C7) — today a rank score is untagged beside a corpus-wide total.
$B query --input '{"filter":{"semantic":"citation gate"}}'
                                                          # TODAY: _score (RRF, ~1/61) with meta.total = whole corpus
                                                          # AFTER: _score_kind:"rrf"; a match count labelled, or omitted

# 9. Order covers every member kind (C2) — today kind:'issue' only.
$B query --input '{"view":"order","filter":{"plan":"ee299cd5-…"},"limit":500}'
                                                          # TODAY: non-issue members (plan/bucket rows) absent from `order`
                                                          # AFTER: order includes them; each item exposes outbound `blocks` + dependent count

# 10. Gated write path is concurrency-safe (C5) under adhd ADR-0001.
#    Run two concurrent terminal transitions against one item.
$B transition … & $B transition … & wait
                                                          # AFTER: one succeeds, one is refused/retried; never a lost update
```

A passing run requires: items 1–9 return the `AFTER` shape, and item 10 shows exactly one successful transition with no torn state on re-read.

## E. What this test does NOT prove

- It does not prove the *derived* verdict is affordable at the N-item list level — §2's bounded ladder is a design, not a measurement. **AC5 requires that measurement** (a default-running p95 bound at a named N), so this document does not need to carry it, but no ticket may close without it.
- It does not prove the merge/redirect semantics against a live sox-store duplicate (adhd ADR-0002 names that a source-store decision).
- It is a walk-through and an oracle, not an executed run. Execution is the acceptance gate for each ticket, not for this document.
