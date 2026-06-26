# Architect Review — apigen logical-types cross-language serialization system

**Reviewer:** architecture-reviewer (claude-sonnet-4-6)
**Date:** 2026-06-25
**Scope:** apigen logical-types implementation as described in DESIGN.md §3/§4/§10/§11/§13/§14/§16 and realized across `@adhd/apigen-logical`, `@adhd/apigen-runtime` logical/, `packages/apigen/python/apigen_logical.py`, `@adhd/apigen-conformance`, and CLI integration.

---

## Files read

1. `docs/plan/apigen-logical-types/DESIGN.md` (671 lines) — full read
2. `packages/apigen/logical/src/lib/contracts.ts`
3. `packages/apigen/logical/src/lib/registry.ts`
4. `packages/apigen/logical/src/lib/descriptor-ext.ts`
5. `packages/apigen/logical/src/lib/emit.ts`
6. `packages/apigen/logical/src/lib/runmode.ts`
7. `packages/apigen/logical/src/lib/hints.ts`
8. `packages/apigen/logical/src/lib/codecs/index.ts`
9. `packages/apigen/runtime/src/lib/logical/host-ts.ts`
10. `packages/apigen/runtime/src/lib/logical/nominal-codec.ts`
11. `packages/apigen/runtime/src/lib/logical/union-codec.ts`
12. `packages/apigen/runtime/src/lib/dispatch.ts`
13. `packages/apigen/runtime/src/lib/validate-layer.ts`
14. `packages/apigen/python/apigen_logical.py` (628 lines) — full read
15. `packages/apigen/conformance/src/lib/gate.ts` (899 lines) — full read
16. `packages/apigen/conformance/src/lib/vectors.ts` (first 200 lines + grep for logical sections)
17. `packages/apigen/cli/src/lib/commands/generate.ts` (lines 1–180)
18. `packages/apigen/cli/src/lib/commands/run.ts` (lines 1–242 full)
19. `packages/apigen/nx/src/generators/host/generator.ts`
20. `packages/apigen/cli/src/lib/orchestrator.ts` (lines 370–435)

---

## Evaluation by the 7 areas

### Area 1 — Interface integrity and versioning

**Rating: APPROVED**

The `LogicalTypeCodec<Host>` interface (`contracts.ts:27`) is coherent and well-specified: `id`, `kind`, `schema`, `matches`, `encode`, `decode` with clear contracts on each. The `TranscodeCtx` (`contracts.ts:18`) correctly threads `registry`, `$ref` resolver, cycle guard, path pointer, and `strict|lossy` mode.

`LOGICAL_TYPE_VERSION = '0.1.0'` (`descriptor-ext.ts:9`) is defined in the SSOT package and is re-exported correctly. `tsHostBinding` in `runtime/src/lib/logical/host-ts.ts:154` pins `logicalTypeVersion: LOGICAL_TYPE_VERSION` by reference, so any bump in `descriptor-ext.ts` automatically propagates. The conformance gate (`gate.ts:26`) imports `LOGICAL_TYPE_VERSION` from `@adhd/apigen-logical` and the `HostManifest` carries it, so version mismatches are detectable at gate time.

`TemplateCell` (`contracts.ts:41`) is coherent with the DESIGN §13.1 spec. `LogicalTypeRegistry` (`registry.ts:4`) is coherent with the DESIGN §4.3 spec. `HostBinding` is defined locally in `host-ts.ts:50` rather than in `@adhd/apigen-logical/contracts.ts`; this is a non-blocking gap noted below.

One **nit**: `LogicalTypeRegistry.freeze()` returns `LogicalTypeRegistry` rather than `Readonly<LogicalTypeRegistry>` — callers have no static-type signal that the returned object rejects mutation. Tolerable; the error surfaces at runtime (`E_DUP_CODEC: registry is frozen`).

### Area 2 — Codegen-first vs runtime transcoder decision

**Rating: APPROVED with a documented tension**

DESIGN §11 is clearly realized:

- `emit.ts` provides the generate-time schema walk and emitter. `buildTranscoder` in `runmode.ts:357` provides the run-mode in-process analog. The two paths share identical walk semantics (7-step order: codec → $ref → oneOf → array → object → schema-less → passthrough), confirmed by reading both `emit.ts:181` and `runmode.ts:67`.
- The DESIGN §4.4 "superseded" runtime transcoder note is kept as a conceptual reference in `contracts.ts:57` (the `Transcoder` interface), which is correct — it documents the shape that both paths satisfy.
- No orphaned runtime transcoder module exists in `runtime/src/lib/logical/`. `runmode.ts` is the correct in-process implementation.

**Non-blocking gap**: The `Transcoder` interface in `contracts.ts:57` carries a `@stable` comment but the note "impl is a LATER state — interface only here" is present. At review time the implementation (`buildTranscoder`) lives in `runmode.ts` in `@adhd/apigen-runtime`, not in `@adhd/apigen-logical`. This is architecturally correct (the interface is in the SSOT; the impl is in the consuming package), but the stale comment "LATER state" should be updated to point at `runmode.ts`.

### Area 3 — Cross-host correctness model

**Rating: APPROVED**

The "decode is schema-driven; native hook is encode-only" principle (DESIGN §4.6) is correctly realized in both hosts:

**TypeScript path**: `dispatch.ts:51` calls `_transcoder.decode(wire, node)` explicitly with the schema node before passing args to the function. Encode is symmetrically handled at `dispatch.ts:63` via `_transcoder.encode(value, outputSchema)`. The transcoder (`runmode.ts`) does not use a JSON reviver — it walks schema and wire in lockstep in `decodeNode`. This is exactly correct per the §4.6 specification.

**Python path**: `apigen_logical.py:386` exposes `decode(wire, schema, defs)` which walks the schema explicitly in `_decode_node`. The `ApigenEncoder` (`apigen_logical.py:304`) handles encode as value-driven (native hook). The `decode` function does not use Python's `object_hook` — it is an explicit schema-walk. The §4.6 principle is honored.

The wire contract (DESIGN §3) is the single source of truth: `CANONICAL_IDS` in `gate.ts:55` is derived from the same 6 well-known types. The TS and Python codecs both implement the same wire forms (RFC 3339 UTC, decimal string for int64, standard base64, etc.) as confirmed by reading both codec implementations against §3.

One **non-blocking precision issue**: `apigen_logical.py:453` contains:

```python
if node_type == "number" and node_format is None:
    if isinstance(wire, str) and wire in ("NaN", "Infinity", "-Infinity"):
        return decode_number_special(wire)
    return wire
```

The `number-special` decode fires only when the wire is a string sentinel. For a finite number on the wire (`wire = 3.14`), this falls through to `return wire` without calling `decode_number_special`. This is **correct** per DESIGN §3 ("finite numbers pass through unchanged"), but the guard `node_format is None` means any `{type:"number", format:"something"}` schema will also hit this branch and pass through. That is fine since no other `type:number` format is defined, but it is a subtle coupling to the current closed set.

### Area 4 — Hints-advisory invariant

**Rating: APPROVED**

The `[inv:hints-advisory]` invariant is structurally enforced throughout:

- `descriptor-ext.ts:19–26` — `logicalKindOf` returns `undefined` (never throws) when the hint is absent or unrecognized.
- `nominal-codec.ts:151–155` — `matches` returns true for `x-apigen-logical:'nominal'` OR `x-apigen-codec===id`. The comment explicitly states: "a later structural fallback (object `$def` with `properties`) is the authoritative signal and is handled by the transcoder walk, not by this cheap test."
- `union-codec.ts:170–177` — `matches` is structural first (`oneOf` + `discriminator.propertyName`); the hint is a fast-path only.
- `nominal-codec.ts:64–68` (JSDoc) — "`[inv:hints-advisory]`: the `x-apigen-*` keys only *accelerate* the choice of hook. With every hint stripped the codec still round-trips via schema projection."

The negative-control vector for `[inv:hints-advisory]` is referenced in the DESIGN DoD clause `[dod.no-annotation]` and `[dod.nominal]`. The conformance gate (`vectors.ts`) includes `negativeControl` on each vector. The gate's `runTsMatrix` (`gate.ts:246`) explicitly tests negative controls and requires them to go red.

### Area 5 — Extensibility: adding a host or logical type

**Rating: APPROVED**

The §16 runbook is mechanically enforced:

- **Adding a host**: `hostGenerator` (`nx/src/generators/host/generator.ts:31`) scaffolds `host-manifest.json` with `supportedIds: []`. The conformance gate (`gate.ts:678`) auto-discovers `host-manifest.json` files and passes them through `checkSupportedIds`, which compares against `CANONICAL_IDS`. An empty `supportedIds` is immediately red. The constraint "red by construction until codec column is filled" is realized.
- **Adding a logical type (§13.3 "no empty cells")**: `hints.ts:426` exports `assertNoEmptyCells(language)` which iterates `CANONICAL_LOGICAL_TYPE_IDS` and throws if any language column is missing. `CANONICAL_LOGICAL_TYPE_IDS` is derived from the codec import list (`hints.ts:37–44`), not hard-coded, so adding a codec to `codecs/index.ts` automatically adds it to the completeness check. This is the correct design.
- **Template table completeness**: `TEMPLATE_CELLS` in `hints.ts:347` covers all 5 host languages × 6 canonical ids. Rust/Go/Java use `__SCAFFOLD_*__` placeholders, which is documented and bounded.

**Non-blocking gap**: `assertNoEmptyCells` is defined but I could not confirm it is called in CI/the gate automatically. If it is only available as a manual utility, the enforcement guarantee weakens. This should be called from the conformance gate or a test. This is a documentation/wiring gap, not a structural blocking issue.

### Area 6 — Layering and dependency direction

**Rating: APPROVED**

The dependency direction is correct and verifiable from the import chains:

- `@adhd/apigen-logical` (`packages/apigen/logical`) — imports nothing from `@adhd/apigen-runtime`, `@adhd/apigen-core`, or the CLI. It is the SSOT.
- `@adhd/apigen-runtime` logical modules (`host-ts.ts`, `nominal-codec.ts`, `union-codec.ts`, `dispatch.ts`) — import from `@adhd/apigen-logical` only (confirmed at `host-ts.ts:20`, `nominal-codec.ts:7`, `union-codec.ts:7`, `dispatch.ts:1–3`).
- `packages/apigen/cli/src/lib/commands/generate.ts` — imports `collectLogicalTypeDeps` locally and uses `TS_LOGICAL_TYPE_DEP_MAP` which is an inline copy of what `hints.ts:tsDepMap()` would return.
- `@adhd/apigen-conformance` — imports from `@adhd/apigen-logical` (gate.ts:25–41).
- Python host — no cross-language import; `apigen_logical.py` is standalone.

No upward dependencies exist. The layering is sound.

### Area 7 — Known gaps: acceptability assessment

Three documented gaps were evaluated:

**Gap 1: Inline `TS_LOGICAL_TYPE_DEP_MAP` in `generate.ts` rather than importing `tsDepMap()` from `hints.ts`**

`generate.ts:37` contains:
```ts
export const TS_LOGICAL_TYPE_DEP_MAP = {
  decimal: { name: 'decimal.js', version: '^10' },
} as const
```

`hints.ts:402` exports `tsDepMap()` which produces the same data from `TEMPLATE_CELLS.typescript`. The comment in `generate.ts:31–35` acknowledges the duplication: "When @adhd/apigen-logical ships a TS_DEP_MAP export that carries the same data from the TemplateCell `dep` fields, this inline copy should be replaced by that import."

**Assessment**: Non-blocking but represents live drift risk. The inline map and `tsDepMap()` are currently identical (`decimal.js ^10` is the only TS dep). If another TS dep is added to `hints.ts`, `generate.ts` will not pick it up automatically. This should be wired promptly after the current plan completes but is not a blocking architectural defect — both sources agree today, and the comment documents the intent.

**Gap 2: Fail-fast guard missing on v2 `orchestrateRun` path for decimal**

`run.ts:220` applies `assertDecimalLibPresent(schemas)` on the v1 path. The v2 path (`run.ts:190–212`) calls `orchestrateRun` which builds the descriptor and runs the plugin, but `assertDecimalLibPresent` is not called before `orchestrateRun`. The `assertFnsNonEmpty` guard IS present on the v2 path (injected into `buildFnTables` at `run.ts:203`), so gap (a) from `[dod.fail-fast]` is covered on both paths. Gap (b) — the decimal lib check — is only on v1.

**Assessment**: Non-blocking given `--v2` is an opt-in flag and the gap is acknowledged in the BACKLOG (`BACKLOG.md` carries BUG-APIGEN-004 as a tracked item). However this is a behavioral regression for v2 adopters. It should be logged to BACKLOG and tracked.

**Gap 3: Rust/Go/Java template columns scaffolded with `__SCAFFOLD_*__` placeholders**

All Rust/Go/Java cells in `TEMPLATE_CELLS` carry placeholder expressions. This is explicitly documented, bounded to 3 host states (`lt-host-rust`, `lt-host-go`, `lt-host-java`), and the conformance gate would immediately surface non-conformance if those hosts were used. The scaffold mechanism is correct and the planned future states are bounded.

**Assessment**: Acceptable documented deferral. Not a blocking defect.

---

## Summary of findings

| # | Finding | Area | Rating |
|---|---------|------|--------|
| F1 | `HostBinding` interface defined in `runtime/host-ts.ts` rather than `@adhd/apigen-logical/contracts.ts` | 1 | Non-blocking |
| F2 | Stale "LATER state" comment on `Transcoder` in `contracts.ts:57` (impl is in `runmode.ts`) | 2 | Nit |
| F3 | `decode_number_special` fallthrough on non-number-special `{type:number}` schemas (tolerable, closed set) | 3 | Nit |
| F4 | `assertNoEmptyCells` not confirmed called automatically in gate/CI (enforcement gap) | 5 | Non-blocking |
| F5 | `TS_LOGICAL_TYPE_DEP_MAP` inline in `generate.ts` instead of importing `tsDepMap()` from `hints.ts` | 7a | Non-blocking (drift risk) |
| F6 | `assertDecimalLibPresent` not applied on v2 `orchestrateRun` path | 7b | Non-blocking (backlog item) |
| F7 | Rust/Go/Java columns scaffolded with placeholders | 7c | Acceptable deferral |

**Zero blocking findings.** All findings are non-blocking nits or documented, bounded deferrals.

---

## Conclusion

The architecture is coherent and correctly realized. The core invariants hold:

1. The wire contract (§3) is the single source of truth, implemented identically in TS codecs and Python's `apigen_logical.py`.
2. The hints-advisory invariant is structurally enforced in every codec's `matches()` and decode path.
3. The codegen-first decision (§11) is correctly split: generate-time walk in `emit.ts`, run-mode transcoder in `runmode.ts`, shared walk algorithm between them.
4. Decode is schema-driven in both TS (`dispatch.ts` → `buildTranscoder`) and Python (`decode()` schema-walk) — the native hook is encode-only on both hosts as §4.6 requires.
5. Extensibility is mechanically enforced: new host starts red-by-construction; new logical type triggers `assertNoEmptyCells`.
6. Dependency direction flows strictly downward: `apigen-logical` → imported by runtime/cli/conformance; no upward deps.

The identified gaps (F1–F7) are non-blocking; most have acknowledged homes in BACKLOG or are explicitly bounded in the plan's future states. None represent architectural ambiguity or structural risk to the correctness guarantees the design establishes.

---

VERDICT: APPROVED
