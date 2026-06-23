<!-- markdownlint-disable MD013 MD033 MD024 -->
# apigen SPEC v2 — Systems-Design Review

> Scope: a design review of `docs/apigen/SPEC.md` (the v2 canonical standard). Judges the design's
> correctness, coherence, trade-offs, extensibility, and risks. `docs/plan/**` ignored by
> instruction. Feasibility claims sanity-checked against the working v1 TS implementation in
> `packages/apigen/` (read-only).

> **Revision note (post-review discussion, 2026-06-22):** D1/D2 were **downgraded High → Med** and
> re-scoped from "lossy type IR / silent correctness hole" to "**codegen ergonomics + one wire
> convention**." On concrete case-by-case analysis, JSON Schema 2020-12 + `$defs`/`$ref` represents
> every serializable boundary faithfully (named unions via `oneOf`+`const`+`$ref`; nominal types via
> named `$def`; recursion via `$ref`) — there is **no accuracy gap** and **no new IR is needed**.
> The corrected decision is pinned in `SPEC.md` §4. Riskiest-assumption #1 and the Smithy prior-art
> delta below are annotated accordingly.

## Verdict

**Sound with revisions.**

The central architecture is genuinely good: a neutral descriptor seam (§4), a protoc-style
extract/generate fan-out (§1, §6), and a single Layer harness per host (§8) is the right shape, and
it is the shape that scales to polyglot. The v1 code proves the core mechanics are real, not
aspirational — `dispatch` (`runtime/src/lib/dispatch.ts:22`) is already the single call path,
extraction already runs as a ts-morph pass (`core/src/lib/extractors/named.ts:14`), and the
plugin/`OutputPlugin` contract already exists (`core/src/lib/types.ts:63`).

The revisions are not cosmetic. The remaining load-bearing claims stated as *settled* but actually
risky are: (1) **"one Layer model that is literally Tower for Rust and gRPC interceptors for gRPC,
with the same semantics"** is asserted but not load-tested against the places those models *diverge*
(ownership, per-RPC vs per-message interception, short-circuit) — see D4; (2) **`id` stability
"across refactors"** is contradicted by the SPEC's own `id`-derivation rules — see D3. Each needs an
explicit design decision before more hosts are built, because each is a contract every host must
honor forever.

*(Originally a third claim — "JSON Schema 2020-12 is a lossy universal type IR" — was listed here as
the top risk. It was **withdrawn** on review: JSON Schema 2020-12 + `$defs`/`$ref` is faithful, no
new IR is needed; see the Revision note above and D1/D2.)*

---

## Strengths (specific)

- **The descriptor as the only neutral contract (§1, §4).** Drawing the seam at a serialized JSON
  descriptor — not a shared in-memory model — is what makes the protoc-plugin claim in §1 real:
  extractors are subprocesses emitting JSON, so a new host needs zero linkage into the orchestrator.
  This is the single best decision in the spec and the v1 `PluginInput` shape
  (`core/src/lib/types.ts:35`) already proves the consume side works.

- **"Specify to Rust, satisfy everyone" (§2).** Using the strictest host as the design oracle is
  the correct discipline for a polyglot contract. It is exactly why the `ctx`-as-typed-extensions
  rule (§8) is right — a mutable bag (which v1 uses: `buildContext` spreads into a plain object,
  `runtime/src/lib/build-context.ts:9`) would be unspecifiable under Rust's borrow checker. Choosing
  the harder model now avoids a v3 break.

- **Capabilities as an open set `{target, layer, mount, envelope}` (§7).** Decomposing a plugin into
  orthogonal capabilities (rather than fixed plugin "kinds") is extensible and the worked examples
  (§7.2) are convincing precisely because each exercises a *different* capability with the same
  manifest. The `mount`-over-common-codegen pattern (openapi plugin = thin shell over
  `@adhd/apigen-openapi`) is the right reuse seam and directly mirrors the §12 packaging rule.

- **Envelope sourced from transport metadata, not body (§9).** This is correct and fixes a real v1
  defect — v1 jams the envelope into the request body via the `data:{}` wrapper
  (`core/src/lib/compose-schemas.ts:43`). Metadata-sourcing is the only model that is uniform across
  headers / gRPC metadata / CLI flags, and it keeps the body == the operation input.

- **gRPC canonical code set as the universal error taxonomy (§9).** Right choice. It is the one
  status taxonomy with first-class, lossless maps to HTTP, CLI exit codes, and itself, and it is
  already the lingua franca of Connect/grpc-gateway. Reusing it instead of inventing one is exactly
  the "reuse, don't reinvent" discipline the rest of the spec sometimes misses.

- **Honest scaling caveat on instances (§10).** Stating up front that instance ops are stateful and
  "do not scale horizontally without sticky routing / external store," and gating them behind opt-in,
  is the kind of bounded honesty that makes the rest of the spec credible.

---

## Design findings

| id | sev | § | Design issue / trade-off / risk | Recommendation (design change) |
|---|---|---|---|---|
| D1 | **Med** *(revised down from High — see Revision note)* | §4 | **CORRECTED: JSON Schema 2020-12 + `$defs`/`$ref` represents the wire shape and named structure of every serializable boundary *faithfully* — the original "lossy type IR" finding was overstated.** Discriminated unions / Rust `enum`-with-data / `Result`/`Option` have a canonical form (`oneOf` + a `const` tag + `$ref` — exactly what `schemars` and v1's `ts-json-schema-generator` already emit); nominal/branded types keep their name via a named `$def` (validation correctly does **not** enforce nominality — on the wire it *is* the base type, so there is nothing to enforce); recursion via `$ref`. The earlier "degrades to `anyOf` / no canonical form" claim was wrong. **No accuracy gap.** | **Pin JSON Schema 2020-12 + `$defs`/`$ref` as the type IR — do NOT invent a new/abstract IR** (that would turn D1 into a permanent per-host lowering contract). The only residual is codegen ergonomics → D2. |
| D2 | **Med** *(revised down from High)* | §4 | **CORRECTED: the genuine residual is ergonomic codegen + one wire convention, not silent fidelity loss.** (a) Generic *factoring* — `Page<User>`/`Page<Order>` lower to two **accurate** concrete `$defs` (verbose, not wrong); an unconstrained generic *operation* isn't serializable, so it's out of scope by physics. (b) Source-language sugar (idiomatic generics, the serde repr attribute) is cosmetic — the wire is exact. (c) 64-bit ints / decimals exceed JSON `f64` — a *serialization* caveat, not a schema gap. | (1) State a **big-int/decimal convention**: string-encode (`type:string, format:int64`). (2) OPTIONAL: extractor-*derived* `x-apigen-*` hints (`nominal`, `enum-repr`) + an OPTIONAL `fidelity:"full"|"lossy"` flag, *only* so codegen emits idiomatic-vs-verbose clients and warns on the rare unresolved generic. (3) **Demote `typeText`** to optional same-host sugar — not load-bearing. |
| D3 | **Resolved** *(decided 2026-06-22)* | §4 | **`id` was called "STABLE across refactors" but its derivation (`namespace/path` from folder/file/export) guarantees only determinism.** Renaming/moving a file or export re-mints the `id`, breaking pinned `--exclude` ids and clients. | **DECISION: option (a) — `id` is "deterministic, not refactor-stable"; refactor-stability is a non-goal** (SPEC §4 + §16 updated). Option (b)'s `@id` source anchor is **rejected**: it's a source annotation, which the new **Tenet 1** forbids. If refactor-stable selection is ever needed, it must come from an out-of-source map, never source. |
| D4 | **Resolved** *(decided 2026-06-22)* | §8 | **"Same Layer semantics for Tower and gRPC interceptors" was asserted, not load-tested.** Tower has ownership + `poll_ready` backpressure with no TS analogue; gRPC **interceptors** are metadata-only/per-RPC and cannot wrap streamed messages. | **DECISION: added normative §8.1 "Layer semantics"** with the logger Layer in **TS + Tower** (proof-of-dual) and 6 pinned rules: short-circuit, outward error propagation, typed-extension `ctx` ownership (already the §8 choice — affirmed), `poll_ready` as **host-optional** (off the base contract), streaming = wrap the response stream, codegen-weave for static hosts. **Key fix: the Rust mapping is a Tower layer (HTTP *and* gRPC, tonic-on-Tower) — "gRPC interceptors" dropped** (too weak for per-message). Model holds. |
| D5 | **Resolved** *(decided 2026-06-22)* | §9 | **Strict `x-<plugin-id>-<field>` binding didn't fit CLI (no header) or MCP (structured `_meta`, not k/v).** | **DECISION: added normative §9.1 envelope-binding table.** Canonical identity `(pluginId, field)`; all k/v carriers (HTTP/gRPC/MCP) share the `x-<pluginId>-<field>` key (MCP via `_meta["x-…"]`, header-shaped per the chosen sub-call); **CLI** alone re-surfaces as `--<pluginId>-<field>` + `APIGEN_<PLUGINID>_<FIELD>` (flag > env); builtin drops the plugin segment; response side uses header→trailer→`_meta`→exit. |
| D6 | **Resolved** *(decided 2026-06-22 — full streaming NOW, not deferred)* | §11 | **Streaming was "in scope now" but underspecified, with zero v1 footprint and the hard error-after-first-chunk case unaddressed.** | **DECISION: full streaming now (caller chose NOT to defer to [v2.1]).** Rewrote §11 normatively: Layer stream-lifecycle (start/each-chunk/end/error) extending §8.1; consumer-pull backpressure; `signal` cancellation runs the **end** path; and an in-band **error-after-first-chunk table** per transport (SSE `event:error` / gRPC trailing status / MCP progressive error / CLI stderr+exit) **adopting Connect's streaming-error semantics** (not invented). Realized as a Tower layer over the streaming `Service` body — never an interceptor (per D4). **Accepted risk:** this is the highest-build-effort area with no v1 footprint (see riskiest-assumptions #5) — the plan must carry real streaming proofs. |
| D7 | **Resolved** *(decided 2026-06-22)* | §13 | **Sidecar-gateway failure/partial-availability semantics were unspecified** (host crash, readiness, IPC cost, "owning host unavailable" mapping). | **DECISION: added normative §13.1 "gateway failure model":** partial availability (a down host fails only its own ops → §9 `unavailable`; others serve); readiness via the §7.2c `_meta/health` mount + aggregate per-host status; gateway supervises/restarts sidecars with backoff; per-op deadline → `deadline_exceeded`, cancellation over IPC; and a **stated cost function** (in-process zero-hop vs one local-IPC round-trip/op, WASM `[OPT]` removes it) that the topology selector minimizes. |
| D8 | **Resolved** *(decided 2026-06-22)* | §4/§5 | **`action→POST`/`query→GET` conflated "is data" with "is safe/cacheable"; and `query` const freshness (baked vs live) was undefined.** | **DECISION (both):** (a) added neutral **`safe`** to the descriptor — defaults from `kind` (`query`→true, `action`→false), **overridable via projection config** (`--opt http.verb.<id>=…` / `apigen.config`), never an annotation (Tenet 1); HTTP verb + cacheability and gRPC idempotency-level now derive from `safe`, not `kind`. (b) **`query` consts are served live** — the descriptor carries the *type*, not the value; the runtime reads the current binding per request, so env/computed consts are never stale-at-extract. Fully zero-annotation. |
| D9 | **Resolved** *(2026-06-22)* | §5 | **No stated uniqueness invariant — default-object recursion + multi-file glob could collide two `id`s onto one MCP name / HTTP route.** | **DECISION:** added a §5 normative **uniqueness invariant** — two distinct `id`s MUST project to distinct targets in every transport; `@adhd/apigen-naming` runs a collision check once over the merged descriptor; a collision is a **hard extract-time error**. |
| D10 | **Resolved** *(2026-06-22)* | §3 | **Opt-out ladder mixed source-symbol rungs with derived-`id` `--exclude` (refactor-unstable).** | **DECISION:** §3 now states `--exclude` accepts **`id` *or* source-glob**, with an **identity note** that `id` selectors re-mint under refactor while globs/markers are refactor-stable (prefer glob for move-surviving selection). Largely folded into Tenet 1. |
| D11 | **Resolved** *(2026-06-22)* | §6 | **JSON-Schema validation was implied == native type guarantee; the gap (coercion/precision/extra-props) was silent.** | **DECISION:** §6 now states validation is **necessary-but-not-sufficient** — a fast-fail pre-filter; the **authoritative** boundary is the host's typed dispatch (static hosts: the codegen-woven deserialize→typed-params step). Hosts MUST NOT treat "validated" as "safe to transmute." |

---

## Riskiest assumptions (ranked)

1. ~~**JSON Schema 2020-12 is a sufficient type IR (D1/D2).**~~ **WITHDRAWN (post-review).** On
   concrete analysis it *is* sufficient: Rust `enum`-with-data and TS discriminated unions round-trip
   faithfully as `oneOf`+`const`+`$ref` (what `schemars`/`ts-json-schema-generator` already emit),
   nominal types via named `$defs`. The residual is codegen ergonomics + the big-int wire convention,
   not fidelity. This is no longer a top risk — see Revision note + D1/D2. The new #1 is D4.

2. **The Layer onion is literally the same model on Tower and gRPC interceptors (D4).** Asserted in
   §8 as settled; it is the second-hardest claim and the only one whose failure would force a
   per-host *semantic* fork of the core abstraction. The streaming case (D6) is where it most likely
   cracks, because gRPC interceptors are per-RPC and Tower backpressure has no TS analogue.

3. **`id` is stable enough to be the durable cross-plugin / `--exclude` / client-pin key (D3).** It
   is stable against re-runs, not against the refactors developers actually do. Every consumer that
   persists an `id` (a pinned client, a CI `--exclude` list) inherits a silent breakage on file/move
   refactors.

4. **Mixed-host `run` via sidecar gateway is "the general, confirmed default" with acceptable cost
   (D7).** It converts a local function call into a cross-process serialized round-trip and turns the
   API into a distributed system; the spec asserted viability without a stated latency cost or a
   partial-failure model. **[Resolved: §13.1 now specifies partial availability, readiness, supervision,
   deadlines, and an explicit one-IPC-hop cost function — see D7.]**

5. **Streaming-through-Layers is deliverable "now" (D6).** Zero v1 footprint, the hardest lifecycle
   contract, and entangled with the two assumptions above. Most likely to slip or ship degraded.
   **[Decided: full streaming kept in scope now — risk accepted.** §11 now specifies the lifecycle +
   Connect's error-after-first-chunk rules; the plan must carry real streaming proofs (gRPC trailing
   status, SSE error frame, mid-stream cancel) so this doesn't ship degraded.]

---

## Prior-art deltas (borrow X from Y)

- ~~**Borrow Smithy's two-layer type model (vs §4's single JSON-Schema IR).**~~ **WITHDRAWN
  (post-review).** This recommendation assumed a fidelity loss that does not exist (D1/D2 revised).
  JSON Schema 2020-12 + `$defs`/`$ref` already carries named unions/enums/nominal types faithfully,
  so a separate abstract shape model would be reinvention for no accuracy gain — and would create a
  permanent per-host lowering contract. **Keep the single JSON Schema IR.** (Smithy's shape/binding
  split remains worth knowing, but is not warranted here.)

- **Borrow buf/Connect's error model — you already did; finish the job (§9).** The gRPC code set is
  the right taxonomy. Connect also defines how those codes behave over a *streaming* response
  (trailers, error-after-first-message) — precisely the §11/D6 gap. Lift Connect's streaming-error
  rules rather than inventing them.

- **Borrow tRPC's procedure `kind`, but not its transport coupling (§4 `kind`).** tRPC's
  query/mutation split is the same idea as action/query, and tRPC learned to keep the
  query==cacheable decision *separate* from "returns data." That separation is D8's recommendation.

- **Borrow grpc-gateway's annotation-driven verb/route mapping as the *override* layer (§5).**
  apigen's convention-driven projection (kind→verb, path→route) is more Tenet-0-pure than
  grpc-gateway's required annotations — keep convention as the default, but grpc-gateway shows you
  need an *override* seam for the cases where convention is wrong (D8); that override is the one place
  an annotation is justified without violating Tenet 0 (it's opt-in, withholding-style like §3).

- **Borrow Tower's `poll_ready`/backpressure question explicitly (§8/D4).** The GraphQL code-first
  ecosystem (Pothos/Nexus) proves a code-first descriptor extracted from host functions is viable —
  that validates apigen's direction. But none of those cross a *runtime* middleware boundary into
  Rust; Tower is the prior art for the harness, and its backpressure/ownership model is the part
  §8's "same semantics" claim has not yet reconciled.

- **What is genuinely novel:** the combination of (a) code-first extraction *and* (b) one runtime
  Layer harness shared across dynamic+static hosts *and* (c) a mixed-host sidecar-gateway run
  topology, behind one CLI. No cited tool spans all three — protoc/buf/Smithy are IDL-first; tRPC is
  TS-only single-runtime; grpc-gateway is gRPC→HTTP only; Pothos/Nexus are GraphQL-only. The novelty
  is real and worth pursuing; the findings above are about making the three pieces honest at their
  seams, not about the ambition.

- **What reinvents and should reuse:** the streaming error semantics (reuse Connect's, do not
  invent). *(The earlier "reuse Smithy/JTD for the type IR" item is withdrawn — JSON Schema 2020-12 +
  `$defs` is the IR; see D1/D2 + Revision note.)*
