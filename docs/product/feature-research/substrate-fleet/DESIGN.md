# DESIGN — Substrate & Fleet (pass 2)

> Resolves the 17 umbrella descendants **not** in BUCKET 1a/1b, plus the two user-requested extensions (cross-project similarity; the sox-doc accuracy defect). Scope: umbrella `ee299cd5-016a-4778-a66f-ed8220e9e84d` descendants outside `cf64c988`/`1e61f827`. Same evidence discipline: every claim below is code-grounded by **symbol** (a bare line number rots on every edit), or marked **[asserted — not verified]**.

## 0. Correction that governs this whole design

**The backlog data store is atomic. File-level atomicity patterns (temp-file-plus-rename, `flock`, `O_EXCL` pidfiles) must NOT be applied to backlog data.** Correctness of a backlog write is the store's job (transactions; `busy_timeout`/`BEGIN IMMEDIATE` per adhd ADR-0001; the parallel-process invariant ADR-0012). The research on atomic install *does* apply — but only to the **install/deploy layer**, which is genuinely file-based (`ownership.json`, `extensions.lock`, host file-drops). The *dynamics* transfer; the mechanism does not.

## 1. Fundamental problems (from the 17-item synthesis)

| # | Problem | Members | Class |
|---|---|---|---|
| D1 | **The host↔server connection layer silently fails.** Tools vanish or hang while an adjacent client (the CLI, another server) stays healthy; a configured server is absent from a dispatched agent; a fetch backend times out on every call; a memory server times out for three independent agents. | 433e940a, 2742c0be, 6619af05, 2d89e154 | genuine infra bug |
| D2 | **A write reports success while keeping less than was written.** `memory_write_batch` returns success and drops topic/tags/importance/summary. | 8dff910a | genuine correctness bug |
| D3 | **Installed/deployed artifacts have no atomic publish and no drift gate.** A fixed temp path races; the lockfile disagrees with what is installed; a host copy drifts from its source; scratch accumulates unbounded. | 5a39db0e, fb627585, 7a4a0813, 46ac745d | infra bug + missing gate |
| D4 | **The knowledge layer froze a vocabulary and retains without an outcome.** One hardcoded bucket set and a mandatory package schema starve non-tool findings; retention happens at write-time, never gated on a verified outcome; retrieval never reports a gap; the storage spec has no durable home. | 8d49cac1, b3b90b2b, 58e899b2, 171c856d, 1ccfabb5 | design/process gap (one real bug: 8d49cac1) |
| D5 | **Agent/skill authoring has no extraction gate and no owner.** No measurement before generalizing an abstraction; no git owner. | dbd2d393, cc5a4906 | design/process gap |
| — | The handoff itself (`8db42169`) is resolved by the **pass-1** deliverable. | 8db42169 | commissioned task |

**Shared roots.** D1 and D2 are one root: **reported state diverges from real state** — the same root as pass-1's `f3a055bb`/`8dff910a` family. D3 and D5 are one root: **an unowned artifact with no verification gate**. D4 is pass-1's Invariant 6 (closed primitives / open vocabulary) applied to the knowledge layer.

## 2. Design

### D1 — Reachability & config-drift (the "silently-absent server" fix)
Converged from MCP spec + systemd/launchd/K8s + AWS backoff:
1. **Three states, never conflated:** starting / live / **ready**. Liveness failure → restart; readiness failure → report "not ready", **no restart**. Gate a heavy cold start as a first-class startup state (the repo has a measured ~14 s MCP handshake; the client's 5 s deadline is the cause of the `-32001`s — fix the *deadline/grace*, not the client with retries).
2. **Readiness exercises the serving path**, not a ping.
3. **Config resolution: total precedence, absolute paths only, and an unknown key is a HARD ERROR** — the recorded `environment` vs `env` silent no-op (empty store) is the exact failure this prevents.
4. **Load-time drift check:** resolve the configured server path and verify it **exists, is executable, and matches the installed artifact's identity**. A config pointing at a deleted directory must fail loudly.
5. **Client resilience:** retry with full jitter + bounded budget + a circuit breaker (`cockatiel`), routed through connect/handshake so a cold start gets a grace window.
6. **MCP era:** implement `server/discover` + the `-32022` fall-forward.

### D2 — Success must imply persistence
Verify-after-write on the batch path: read back every structured field the caller supplied and fail if any is absent. A success envelope must never be emitted before the fields are confirmed present. *(Same rule as pass-1 C5/C7.)*

### D3 — Install/ownership: parallel-safe publish + drift gate + bounded retention
Scoped to the **install/deploy layer only** (see §0):
1. **Unique temp name** (pid + counter + random, `O_EXCL`) on the same filesystem, then one atomic `rename`; today's **fixed `.tmp` publish is the race at two sites, not one** — `writeOwnershipAtomic` (`ownership.ts`) **and** `writeLockfileAtomic` (`install.ts`). Named by symbol, not line — a bare line number rots on every edit (the same failure the attestation design exists to fix).
2. **Ownership index** — already decided in-house (sox ADR-0004: `ownership.json` keyed by `(extId, scope)`), plus identity = id + checksum (ADR-0003). Build on it; do not reinvent.
3. **Detect ≠ remediate:** a read-only drift pass emits an explicit verdict **{still-valid | drifted | gone | foreign}** scoped by ownership; remediation is a separate deliberate act.
4. **Compare content hashes, never mtime/size.**
5. **Bounded retention:** classify roots vs unreferenced; age and/or size policy; soft-delete to a trash namespace with a grace window; never auto-clean what has no roots model (the 1.4 GB snapshot accrual is the counter-example).

### D4 — Knowledge layer: outcome-gated, open, coverage-aware
1. **Split claim from outcome.** The record gains `expectation{expected outcome, confidence}` and `outcome{observed result, observed_by, method, observed_at}` as a **separate, append-only** object; the verdict axis becomes tiered — `unverified | self-reproduced | independently-reproduced | replicated | stale | refuted | unknown` — never one boolean.
2. **Open facet vocabulary:** orthogonal facets (not an enumerative list); new terms admitted *unpromoted*; a governed promotion gate with a demand criterion and an origin tag; and the hard rule **never redefine a term — mint a new one**.
3. **Coverage-aware retrieval:** retrieval carries an obligation to report absence — low max similarity, flat distribution, high top-k entropy, fast decay ⇒ **abstain + log the gap**. *(Threshold calibration is the weakest link; treat abstention as a tunable, logged policy.)*
4. **Storage spec** gets a durable home (the ADR-0003 request in `1ccfabb5`, owner-gated). Note `171c856d`'s own body **corrects** its title: memory-core is **owned source**, not an external owner.

### D5 — Agent/skill authoring gate + git owner
1. **Extraction gate + second-instance test** before a mechanism is generalized (the missing gate `dbd2d393` names).
2. A **git-manager** owning git ops with a per-project `GIT-POLICY.md` as the binding (`cc5a4906` — note its own enrichment rebrands "git-operator" as the broader `git-manager`). Blocked by D3.

### X1 — Cross-project **similarity** detection & reviewed linking (user-requested)

> **Rename (owner decision).** "Duplicate" is the wrong word in general: the scan detects **similarity**, not identity. `duplicate_of` is **reserved** for the reviewed judgement that two items are *actually the same*, and is not repurposed. A reviewed similarity link uses the **existing `relate` verb** with a new relation **`similar_to`** — **no new verb**, and `link-duplicate` is removed everywhere.

**Verified today:** the scan is **project-scoped only** (`create-issue.ts`'s `scanForDuplicates`, `filter.project`), never component-scoped, never store-wide; the embedding space is already **store-wide** under one `modelId`, partitioned only by an `ids` allow-list (`bootstrap.ts`); `duplicate_of` **can already cross projects** (`relate.ts`); but **no verb, view, filter or card field surfaces it** (`getIncomingEdges` is defined and never called; `related` resolves only `relates_to`). Same content under two repo spellings is therefore never surfaced (`GAP-MATRIX.md`, `FEATURE_COMPARISON_SOX.md`).

**Extension of C1** (canonical identity + reviewed merge-with-redirect), generalized from *project* to *issue*. Similarity is **`n:m`** (many items may be similar to many), so it needs **no canonical head**; the reserved `duplicate_of` stays `n:1` with a canonical/redirect resolver for the actual-same case only. Advisory-only; the reviewed link is `relate {rel:'similar_to'}`; multi-signal + margin guard; a distinct cross-project threshold (the 0.8 default was calibrated for byte-identical refiles).

### X2 — The sox comparison doc is stale (discovered this session)
`docs/dispatcher/FEATURE_COMPARISON_SOX.md` was synthesised without re-reading code ("No code or docs were re-explored during synthesis", `:5`). Verified defects: its self-declared §1b does not exist in the revision; `SL2-01`'s "any caller can seize a claim" is **false now** (`claim.ts:397-423` throws `ClaimHeldError`; `renewClaimNode` = 0 hits); its adhd-side file:line anchors (`structure.ts`, `lifecycle.ts`, `crud.ts`, `mapping.ts`, `audit-log.ts`) do not exist in the tree; it names the dependency edge `DEPENDS_ON` where the shipped relation is `blocks`. **Enrich the existing accuracy item (`ededcf57`), do not file a duplicate.**

## 3. What is refused

- **File-level atomicity for the backlog store** (§0).
- **Absorbing the sox fleet/runtime layer**: liveness reclamation beyond a read-side condition, review routing, rework accounting, schedulable queues, durable assignment, process supervision, replayable event-log history. Each is dispatch/fleet. Verified: exactly one sox capability is in scope and already covered (claim refuses a live blocker).
- **Auto-merging / auto-linking similar items.** Candidates are advisory; linking is reviewed and explicit (`relate {rel:'similar_to'}`).
- **A single `verified` boolean** for knowledge records — it destroys the evidence tiers.

## 4. Out of scope (with reasons)

| Item | Reason |
|---|---|
| Liveness-based claim **reclamation** | Deciding a worker is dead and re-queuing its work is process supervision. Our in-scope half is the read-side `ClaimStale` condition (pass-1 C6). |
| Review routing, rework accounting, queue/assignment | Dispatch methodology; pass-1 §3 refuses persisting orchestration state. |
| Replayable/drift-verifiable authoritative history | A store-substrate decision (adhd ADR-0002), not an actionable-store primitive. |

## 5. Acceptance criteria
Per ticket. Every AC names a real entrypoint + observable and a negative control that fails if the bug is reintroduced (§ D1–D5, X1 below).

## 6. Research incorporation — finding → design element

| Thread (systems surveyed) | Converged primitive | Delivered as |
|---|---|---|
| Local-server reachability — MCP spec, systemd, launchd, pm2/supervisord, K8s probes, socket activation, AWS jitter, circuit breakers, XDG, proper-lockfile | **starting/live/ready trichotomy**; readiness on the **serving path**; **total precedence + hard-error on unknown keys + absolute paths**; **load-time identity drift check**; **retry+jitter+bounded budget+breaker**; **MCP era fall-forward** | §2 D1, ticket D-A |
| Atomic install & drift — `rename(2)`/`O_EXCL`, flock/mkdir-lock, pnpm CAS, Nix activation+GC, Terraform/kubectl/Argo drift, rsync `-c`, ownership indexes, ADR-0003/0004 | **unique temp + one atomic rename**; **ownership index**; **detect-vs-remediate** with an explicit verdict; **content-hash comparison, never mtime/size**; **bounded retention with a roots model + trash grace window** | §2 D3, ticket D-B |
| Knowledge layer — CBR 4R, SKOS, facet analysis, Dublin Core AP, schema.org promotion, OBO term stability, PROV-O, ACM badge tiers, coverage-aware retrieval | **claim/outcome split**; **tiered verdict**; **open facets + governed promotion + term-stability** (never redefine — mint new); **coverage-aware abstention** with cheap similarity-profile signals | §2 D4, ticket D-C |

**Findings that became requirements on this pass (previously cited, not yet encoded):**

1. **Watchdog for the hung-but-alive process.** A liveness ping cannot see a frozen event loop. Readiness must be paired with a **watchdog** (the `WatchdogSec`/`WATCHDOG=1` analogue); a process that is alive but no longer serving must be reported and restarted. **macOS/launchd has no equivalent** — that is a real platform gap to state, not to paper over. Added to D-A; D-A AC4 gains the hung-but-alive case.
2. **The lock bounds duplicate work; it must never carry correctness.** In the install path the **atomic rename is the correctness mechanism**, and the advisory lock is an optimisation. A design whose correctness depends on the lock is broken by any non-cooperative writer. Added to D-B as an explicit invariant, with a test asserting a concurrently-running non-cooperative writer cannot corrupt the result.
3. **Write the ownership entry AFTER the effect succeeds.** A marker written before the effect is a lie the next run trusts; a crash between marker and effect must leave the artifact untracked-and-repairable, never tracked-and-absent. Added to D-B; D-B AC2 (idempotent re-run) is extended to assert the ordering under an injected failure between the two steps.
