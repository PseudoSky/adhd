# Spec 03be9e42 — apigen must not route state-mutating operations as GET

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 03be9e42-302d-4da9-9ad4-ae5db8befc34 (bug, HIGH, project adhd)
dor: needs-decision — check: the done-state ("which ops may be GET") cannot be written until product picks the safety-signal policy (D1); every other segment is fully specified. Size: M.

## Observed facts (O = opened by architect; R = reported by item only)
- O: the hoist is NOT in `plugin-api-fastify/run.ts` (item's citation is wrong). It is two call sites of one predicate: `packages/apigen/apigen-engine-naming/src/lib/naming.ts:150-151` (`op.safe || isPrimitiveOnlyInputSchema(op.input) ? 'GET' : 'POST'`) and `packages/apigen/apigen-core-client/src/lib/compose-schemas.ts:231-232` (`fnSchema.safe === true || isPrimitiveOnlyInputSchema(fnSchema.input)` stamped onto `x-apigen-safe`, read by `httpVerb()` at naming.ts:210-213, used by express/fastify run+generate). Predicate: `apigen-core-client/src/lib/get-safety.ts` (`isPrimitiveOnlyInputSchema`).
- O: the hoist is deliberate (FEAT-APIGEN-022) and pinned by conformance vectors `[naming.verb.1]`, `[naming.verb.NEGATIVE.1]` (`apigen-engine-conformance/src/lib/vectors.ts:186-230,1044-1079`, `src/test/vectors.spec.ts:147-181`) which run across TS, Python, Java hosts.
- O: `Operation.safe` is never true for extracted functions today (compose-schemas.ts:221-225 comment: "no-op today"; extract-classes.ts:248 `safe:false`), so shape alone decides the verb.
- O: `descriptor.schema.json` line 56 says safe is "overridable at projection time via config, never a source annotation (Tenet 1)". The item's `@safe`/`@readonly` JSDoc option therefore violates Tenet 1 — rejected.
- O: manual override already exists: `--opt http.verb.<id>=GET|POST` / `apigen.config` (`entrypoint/apigen-cli/src/lib/orchestrator.ts:204-265`).
- O: the item's backlog evidence is STALE: `entrypoint/backlog/src/client.ts` and the 11 named fns no longer exist; backlog mounts 29 verbs each taking one object `input`, which `isPrimitiveOnlyInputSchema` rejects, so they are POST. The defect is generic to any package with scalar-only mutating fns.
- O (gx impact, main index): `isPrimitiveOnlyInputSchema` upstream = CRITICAL (24 symbols; d1 `composeSchemas`, `project`; flows runAllVectors, py-flask/py-grpc/java-javalin `run`, openapi `toOpenApi`, gateway `resolveSource`, runtime `createApiPackage`/`buildOpPlan`, backlog `buildBacklogApigenPackage`).
- ADRs read: adhd 0006/0007 freeze backlog's verb/envelope surface (not HTTP route verbs; backlog mounts are already POST — no frozen surface moves). 0002 (fix at source) satisfied: fix is in apigen, not backlog.

## Design decisions
D1 (PRODUCT DECISION, recommended Option A). Safety signal policy:
- A (recommended): GET only when `op.safe===true` OR config marks the op safe (`http.safe.<id>=true`, new key beside `http.verb`) OR the existing `http.verb.<id>=GET`. Primitive-shape becomes a necessary-but-not-sufficient eligibility check (a safe op with array/object params stays POST). Default for every extracted function = POST. No name heuristics, no env vars, no source annotations.
- B: shape AND read-verb name allowlist (get*/list*/find*/is*/has*/count*/search*). Rejected as default: a name heuristic is exactly the class of guess the bug title names; misses real reads (`blockers`, `auditTrail`) and mis-hoists `getOrCreate*`.
- C: keep as is + document. Rejected: leaves non-idempotent writes prefetchable/cacheable.
- D: `@safe` JSDoc. Rejected: Tenet 1.
Consequence of A: pure utility ops (FEAT-APIGEN-022's `humanize-bytes` case) become POST unless declared; that is a deliberate breaking change to generated HTTP surfaces => minor-version bump + CHANGELOG entry per package; MCP/CLI/gRPC unaffected (they do not read the verb).
D2: one predicate, not two. Export `isGetEligible(op|schema, config)` from `apigen-core-client` (extends get-safety.ts) and make both `project()` and `composeSchemas()` call it, preserving the "single decision point" invariant stated in naming.ts:131-139.
D3: conformance vectors are rewritten, not deleted: `naming.verb.1` flips to POST; add `naming.verb.SAFE-CONFIG.1` (declared safe + primitive => GET) and a negative control (declared safe + array param => POST). Vector edits are test-maintenance, authored by `test-author`.

## Write-scope (exact)
- /Users/nix/dev/node/adhd/packages/apigen/apigen-core-client/src/lib/get-safety.ts, compose-schemas.ts, types.ts (config threading), index.ts
- /Users/nix/dev/node/adhd/packages/apigen/apigen-engine-naming/src/lib/naming.ts (`project`, `ProjectionConfig.http.safe`)
- /Users/nix/dev/node/adhd/entrypoint/apigen-cli/src/lib/orchestrator.ts (parse `http.safe.<id>=true`, ~l.204-265)
- /Users/nix/dev/node/adhd/packages/apigen/apigen-engine-conformance/src/lib/vectors.ts + src/test/vectors.spec.ts (test-author)
- tests: `apigen-core-client/src/test/get-safety.spec.ts`, `optional-primitive-get-safety.spec.ts`, `apigen-engine-naming/src/test/naming.spec.ts`, `apigen-plugin-api-fastify/src/test/plugin.e2e.ts` (v2-fastify.verb.*), `entrypoint/backlog/src/api.surface.spec.ts`
- docs/CHANGELOGs: `docs/apigen/SPEC.md` §5 verb derivation, `docs/spec/apigen/` if it names the rule, CHANGELOG of the 3 packages.
- NOT in scope: `plugin-api-fastify/src/lib/run.ts` (consumes `x-apigen-safe`; unchanged).

## Acceptance criteria
- AC1 A function whose input is all-primitive and which is not declared safe projects to POST on HTTP (naming `project()` and composed `x-apigen-safe=false`).
- AC2 A function declared safe via `op.safe` or `http.safe.<id>=true` AND primitive-only projects to GET; declared safe with a non-primitive param stays POST.
- AC3 `project()` and `composeSchemas()` return the same verb for every case in AC1-AC2 (single predicate).
- AC4 `http.verb.<id>` override still wins over everything (precedence unchanged).
- AC5 Live fastify and express servers: an undeclared scalar-only mutating fn answers 405/404 to GET and 200 to POST; a declared-safe fn answers GET.
- AC6 Backlog regression: `describeMountedSurface` of the 29 verbs reports no `httpVerb:'GET'` for any verb outside an explicit safe list (reads `get`, `query`, `lookup`, `embedding-status` only if declared).
- AC7 Conformance gate (`runAllVectors`) passes on TS, Python, Java matrices with the revised vectors.

## Test plan (tier default S; cite `03be9e42 AC<n>`)
AC1-AC4: S, pure functions in get-safety.spec/naming.spec, negative controls included. AC5: P (existing `plugin.e2e.ts` lane, real fastify/express inject or listen; justification: cannot be observed at S because the verb is only visible at the HTTP edge). AC6: S via `api.surface.spec.ts` with real mounted operations. AC7: existing gate (`gate.spec.ts`) — vectors revised by test-author first (red against old code).

## Risks / serialization
- Breaking generated HTTP surfaces for every apigen consumer (D1-A). Mitigate: CHANGELOG + `http.safe` migration note; run `npx nx affected -t test,e2e` (apigen family is wide; CRITICAL gx rating).
- Shares `entrypoint/apigen-cli/src/lib/orchestrator.ts` and apigen-core-client with no other spec in this batch. Serialize behind any open apigen runmode/batch worktree (b-apigen-*) touching compose-schemas.ts.
- Open decision for product: D1 A vs B; whether the breaking change needs a deprecation window (one release emitting a warning when an undeclared primitive-only fn would have been GET).
