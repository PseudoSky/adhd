<!-- markdownlint-disable MD013 MD033 -->
# apigen-logical-types — plan context (authoring-ready, not yet scaffolded)

> **Status:** DESIGN COMPLETE · decisions locked · **not yet** a runtime state machine (no `state.json`/`dag.json`).
> **Full spec:** [`DESIGN.md`](./DESIGN.md) (§1–§18) — the normative authoring brief.
> **Author role:** planner (design) · **Created/Updated:** 2026-06-23

## Goal
One schema-driven, registry-based mechanism that round-trips every non-JSON-native value — built-in
well-known scalars (Date, int64, decimal, bytes, UUID, …) **and** user classes / discriminated unions — over
the JSON wire, **identically across host languages** (TS + Python today; Rust/Go/Java later), by binding to each
language's **native serialization hook** rather than hand-rolling per-type codecs. A `Date` is a class apigen
*ships* a codec for; a `User` is a class apigen *extracts* a codec for — **one registry, one transcoder.**

## Architecture in one line
**Codegen-first** (§11): a single `@adhd/apigen-logical` package owns the canonical table; the generator walks
the schema **once** and emits direct, idiomatic (de)hydration glue from per-language **template columns**
(§13). Encode uses the native hook; decode is schema-driven (the only direction that needs the schema). No
per-host runtime interpreter.

## Approved decisions (2026-06-23, pseudosky)
- **Map keys** → array of `[k,v]` pairs, keys codec-encoded (§8.1).
- **Cycle policy** → `strict` (reject with diagnostic); ref-tracking deferred (§8.3).
- **Decimal** → branded string in TS (zero-dep) / native Decimal in Python·Java·Rust·Go (§8.2).
- **Nominal id** → qualified `<namespace>.<Class>`, pinned in conformance vector + host-manifest (§8.4).
- **Non-reconstructable classes** → gated by the extractor's opt-in-instances flag (§8.5).
- **`logicalTypeVersion`** → any wire-table or pinned-lib-version change bumps it; breaking for clients (§8.6).

## Wrapped backlog bugs (§15)
| Bug | Folded as | DoD |
|---|---|---|
| BUG-APIGEN-005 | **is this plan** (all phases) | dod.scalar/int64/nominal/union/crosshost |
| BUG-APIGEN-004 | `lt-fail-fast` (0-funcs + missing optional dep) | `[dod.fail-fast]` |
| BUG-APIGEN-002 | `lt-dep-manifest` (per-surface real deps) | `[dod.gen-deps]` |
| BUG-APIGEN-003 | **not related** (SSE — now RESOLVED/VERIFIED) | — |

## Scope at a glance
- **+1 new package** `@adhd/apigen-logical`; **5 extended** (core, runtime, conformance, python, schema).
- **~24 states**, **~4,500 LOC** (codegen-first sheds the ~1,000-LOC runtime transcoder + Python mirror).
- **Cross-host enforcement** (§10): conformance vectors as a TCK; "no empty cells" matrix; `apigen:conformance`
  CI gate auto-discovers hosts; a new host = *a template column + a dep list + a green harness* (§16).

## Type inventory & per-language burden
See **§12** (the ✓/✗ matrix) and **§13.2** (filled template columns). Custom entries needed per host (of 20
rich types): TS 15 · Python 19 · Rust 10 · Go 14 · Java 13. Third-party deps: Python 0, Java 1, TS 1, Go 2,
Rust ~6 (§14).

## Next step
Authoring-ready. On the word "author", scaffold the plan-state-machine (`plan-scaffold.js`) from `DESIGN.md`:
states §17, DoD §7, guards/contexts from §4 + §13. **Not dispatched yet** per standing instruction.
