<!-- markdownlint-disable MD013 MD033 MD024 -->
# v2 Plan Remediation Amendment — Proposal (for approval)

> Folds **both** architect reviews into one planner-class amendment of the apigen v2 plan:
> the **plan-structure** review (`replan-architect-review.md`, R1–R13) and the **design** review
> (`SPEC-design-review.md`, Tenet 1 + D1–D11, now locked into `docs/apigen/SPEC.md`).
> **Status: proposed — not yet applied.** Execution waits on the three decisions in §H.

---

## A. New phase `v2-scaffold` — create the 9 missing packages in final §12 homes  *(fixes R3, R6, BLOCKER-3)*

The v2 states reference projects no state creates. Add a scaffold phase **first**, placing packages in
their final `core/` vs `ts/` homes so `package-restructure` becomes a cheap verify gate (R6), and
reserving the F13/F16/F24 nx wiring (`tsconfig.base.json` paths, `vite.config.ts`, `tsconfig.lib/spec`).

- **`scaffold-v2-common`** → `@adhd/apigen-naming`, `-errors`, `-schema`, `-conformance`, `-gateway`, `apigen-codegen-openapi`.
- **`scaffold-v2-ts-plugins`** → `apigen-ts-plugin-{logger,openapi,health}` + final `ts/*` homes for the restructured transport plugins.
- Deps: each downstream work state (`naming-helpers`, `error-taxonomy`, …) gains a dep on the scaffold state. `apigen-schema` gets its own owning work state (was referenced but unowned).

## B. Author per-state criteria for ALL v2 states  *(fixes R2, BLOCKER-2)*

Every v2 state currently has `_No criteria yet._`. For each, `plan-scaffold.js add-criterion` with a
**mirrored audit check id** that drives the real observable (not `nx test` proxy). Folds the design
work into the right state:

| state | added criteria (design delta folded in) |
|---|---|
| `canonical-descriptor` | `safe` field (D8); deterministic `id` (D3); **JSON Schema 2020-12 + `$defs` IR** (D1/D2); big-int string-encode; optional `x-apigen-*` hints + `fidelity` flag |
| `naming-helpers` | verb-from-`safe` + **override-via-config** (D8/Tenet 1); **collision check** over merged descriptor (D9); per-transport envelope-binding projections (D5) |
| `ts-extractor-by-symbol` | name by **exported symbol** (F28/F29); `safe` default from `kind`; **`query` = live** (type not value, D8); `x-apigen-*` hints; export-shape matrix **incl. anonymous-default + CJS** (R13) |
| `layer-harness` | §8.1 Layer semantics — short-circuit, outward error, typed-extension `ctx`, stream-aware `next()` |
| `central-validation` | validation Layer + **necessary-but-not-sufficient** boundary note (D11) |
| `error-taxonomy` | gRPC code set + status maps **incl. streaming error-after-first-chunk carriers** (D6) |
| `plugin-interface` | capabilities {target,layer,mount,envelope}; envelope binding; `safe` override hook |
| `projection-transports` | **envelope from metadata** per §9.1 (D5); **verb from `safe`** + override config (D8); `POST/GET` correctness |
| `logger-layer-plugin` | Layer dogfood; stream-lifecycle aware |
| `mount-plugins` | openapi + health mounts; **health mount feeds gateway readiness** (D7) |
| `unified-cli` | detect→extract→merge→gen/run; `--type`/`--use`; **projection-override config** (`--opt http.verb.<id>=…` / `apigen.config`) (Tenet 1/D8) |
| `gateway` | **§13.1 failure model** — partial availability, health-readiness, supervision/restart, deadlines, cost-based topology selection |
| `conformance-vectors` | cross-host vectors: descriptor round-trip, naming/collision, envelope binding, error mapping, validation-not-sufficient |

## C. New states the locked design now requires

- **`streaming-projection`** *(v2-projection)* — full streaming across all 4 transports + Layer
  stream-lifecycle + **Connect error-after-first-chunk** (SSE `event:error` / gRPC trailing status /
  MCP progressive error / CLI stderr+exit) + mid-stream cancel. Split out of `projection-transports`
  so it's independently provable. **[D6 — confirmed in scope now]**
- **`class-exports`** *(v2-core)* — static methods → ops now; instance `constructor`/`instance-method`
  + registry + TTL/dispose lifecycle (opt-in). **[§10 — gated on decision H2]**
- **`second-host-min`** *(new phase `v2-host-contract`)* — a minimal **real** non-TS host
  (Python `-extractor` + `-runtime` + echo plugin + gateway adapter) so the sidecar-gateway IPC and
  partial-availability are proven against a true foreign runtime, not a TS stub. **[R9/D7 — gated on H1]**
- **`neutral-codegen`** *(optional)* — `apigen-proto` / `-docs` / `-client-<lang>` generators.
  **[§12 — gated on H3]**

## D. Audit script `audit_apigen.py`  *(fixes R1, BLOCKER-1)*

Add and **register in `PHASES`**: `phase_v2_core`, `phase_v2_harness`, `phase_v2_projection`,
`phase_v2_streaming`, `phase_v2_gateway` — each driving the **real** specs with exit-code gating and a
proven negative control (no `test -f` theater). Without this the v2 audit guards exit 2 forever.

## E. Definition of Done  *(fixes R4, R7, R10)*

- **Rewrite dod.1/2/5** to assert the data round-trip via the **§9.1 metadata carrier** (not the
  `{data:…}` body); **repoint `probe_mcp.mjs` → the F26 bundled bin**; add the standalone-bin clause.
- **dod.6** → enumerate the **full v2 project set**, gated **after** `package-restructure`.
- **dod.9** → add `anonymous-default` + CJS shape fixtures (R13).
- **New behavioral dod:** streaming (error-after-first-chunk proven, mid-stream cancel),
  `safe`/verb-override, collision = hard error, gateway partial-availability; classes if H2 = now.
- **Re-confirm DoD** (dod.9–13 + new clauses) with the caller, then `state-transition.js --confirm-dod` (R10).

## F. DAG edges  *(fixes R5)*

- Add real edge `package-restructure → conformance-vectors` (shared `conformance/project.json`).
- Serialize the v2 audits as **edges** (they share `audit_apigen.py`), not just an orchestrator memo.

## G. Tiering  *(fixes R11)*

- `package-restructure` → **opus** (or add a checkpoint after it — highest blast radius: tsconfig
  paths + every plugin rename). `gateway` → opus. Audits → opus. Carry tiers in the ledger routing table.

---

## H. Decisions required before execution

1. **Second host (R9/D7).** Stand up a **minimal real Python host** now (honest proof of gateway IPC +
   partial availability) — **or** narrow `dod.12` to in-TS tag-routing and defer real cross-language?
   *(Recommend: minimal real host — the gateway failure model is now normative; a TS stub can't prove it.)*
2. **Classes §10.** Build **static methods now + instances (opt-in) now**, or **static now / instances later**?
   *(Recommend: static now, instances now behind the opt-in — SPEC says both are in scope.)*
3. **Neutral codegen §12.** Include `proto` / `docs` / `client-<lang>` generators this milestone, or
   later (openapi + jsonschema already covered)? *(Recommend: defer proto/docs/clients to the next
   milestone; they're descriptor-only and don't gate the host contract.)*

## Execution order (on approval)

`--amend --type replan` (records this) → `add-phase v2-scaffold` (+`v2-host-contract` if H1) →
scaffold states → `add-criterion` across all states → new states (C) → audit phases (D) → DAG edges (F)
→ DoD edits + `--confirm-dod` (E) → `gap-check`/`integrity`/`env-pin` reconcile → updated board + ledger.
