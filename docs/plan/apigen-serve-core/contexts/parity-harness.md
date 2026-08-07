# parity-harness — shared golden-fixture parity harness

**Phase:** phase-1 · **Kind:** work · **Depends on:** none · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test`

---

## Goal

A shared parity harness exists (`captureGolden`, `assertParity`, `proveNegativeControl`) that drives a transport through its [def:real-consumer-protocol], records a golden snapshot, and asserts a re-capture deep-equals it. It is the machinery every transport migration's [def:parity-gate] runs on.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [parity-harness.1] harness exports captureGolden (drives a real consumer protocol, records snapshot)

- [parity-harness.2] harness exports assertParity (deep-equal vs committed snapshot)
- [parity-harness.3] parity-harness self-test passes
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-core-client/src/lib/plugin.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-plugin-mcp/src/lib/run.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/run.ts"]
mutates:    ["packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.spec.ts"]
```

---

## Semantic Distillation

Proposal §6. The harness is test-support (under `src/test-support/`, excluded from the production build inputs) and is imported by each transport's spec via a test-only path. It drives `fetch`/`@modelcontextprotocol/sdk`/a spawned child/an HTTP-gRPC client — NEVER plugin internals (AGENTS.md §7). It captures CURRENT (pre-migration) behavior, so it does NOT import the new serve-core primitives — which is why it is write-disjoint from and parallel to `serve-core-primitives`.

---

## Contract Promise

**added:** `captureGolden(driver, fixtures) -> snapshot`; `assertParity(committedSnapshot, recapture)` (deep-equal, teeth per [inv:byte-identical]); `proveNegativeControl(runner, patchPath)` ([inv:negative-control]). **modified/deleted:** none in shipped source.

---

## Commit points

After harness + self-test green: `test(apigen-engine-runtime): add shared serve-core parity harness`.

---

## Notes for executor

Shared golden-fixture parity harness (proposal §6): golden-capture + deep-equal re-capture + negative-control helpers, driving REAL consumer protocols.
