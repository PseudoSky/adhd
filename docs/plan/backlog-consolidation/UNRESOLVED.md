# UNRESOLVED — Backlog Consolidation Demo

Tracked guesses and gaps referenced by `DEMO.md`. Every `⟦U#⟧` stub used in the demo has exactly one row below; the stub set here is identical to the set in `DEMO.md`.

## Guessed interfaces (stubs)

| Stub | Surface | Guess | Grounding | How to confirm |
|------|---------|-------|-----------|----------------|
| U1 | Error `code` + `required_kind` literal for a blocked terminal transition (W4 / S05 AC2) | `error.code: "precondition_failed"`, `error.required_kind: "published-artifact"` | S05 AC2 fixes the *typed refusal shape* `{code, required_kind}` and the severity model, but the corpus does not fix the exact `code` string | Read the S05 implementation; confirm the refusal object's literal `code` and that `required_kind` equals the `evidence{kind}` value |
| U2 | Update-time advisory `warnings[]` entry shape (W1 / research R1b) | `warnings[]` entries `{kind:"collision", score_kind:"rrf", candidateUid, cosine, scope, suggestedAction}` | Research fixes "advisory, on a still-ok envelope"; the per-entry field names are not pinned | Inspect the shipped update-path warning emitter once S03 lands |
| U3 | `collisions` view response object shape (W1 / research R1c) | `data.collisions[]` with `{kind, members[], score_kind, score, axis?, path?}` plus completeness `meta` | Research fixes the three *sources* (semantic / write-scope / cycle) and "never blocks"; the response envelope is unspecified | Read the S03 collisions view implementation |
| U4 | Merge verb payload fields beyond `{from,to}` (W2 / S02 AC2) | `data: {redirectUid, from, to, softRetired}` | S02 fixes the verb name `link-duplicate` and input `{sourceUid,targetUid,by,reason}`; the response fields are not fixed | Confirm the merge handler's response shape |
| U5 | Additive `get` field name returning the state-revision payload (W5 / S12 E4) | `fields:["stateRevisionPayload"]` (and an interval field `claimInterval` in W3) | SPEC-SET S12 E4 and S04 AC3 fix the *requirement* (return the fragment, not a pointer) but not the field name; S11 R1 fixes the interval's *value shape* but not the reader field | Read the S12/S11 reader implementation to learn the exact additive field (or `state-get` verb) name |
| U6 | `stale` error-code literal for a non-matching state-revision token (W5 / S12 E4) | `error.code: "stale"` | S12 E4 fixes the *semantics* (stale, never silent fresh) but the corpus does not fix the code string | Inspect the staleness ladder's error literal |

## Scope finding (corrects a spec premise)

**S11 R1's stated premise is inaccurate.** R1 says the claim interval is "RED today: auditTrail shows no claim/renew/release rows." A live probe of the shipped build shows `claim` **does** append an audit row (`{"action":"claimed","to":"<claimedBy>",...}`, visible via `get fields:["auditTrail"]`). The genuine remaining gap is narrower and is what the demo asserts: **no durable claim *interval* is persisted** (the row lacks `paths[]`, `sessionId`, and `leaseExpiry`) **and** the `reservations` view / `timeline` verb do not exist. `DEMO.md` §3 states the gap this way and does **not** claim "no claim rows." Recommend updating S11 R1's current-state note.

## Assumptions

- The demo runs against `--namespace test` (a persisted, non-production store). `sandbox` is a fresh throwaway per invocation and cannot carry state between commands, so it is unusable for multi-step flows.
- Embedding is disabled by default; the demo treats semantic collision detection as degraded (fails closed only) rather than assumed-on.
- Fixture titles are prefixed `DEMO:` and every node is soft-invalidated + the project retired in §10.
- Actor id `demo-pm:0001` follows the required `${agentName}:${instanceId}` `by` format.
- Where a verb's exact output was live-probed, the observed shape is quoted; where it was not, the step is SPEC-ONLY and the expected output is the target, never claimed as observed.
