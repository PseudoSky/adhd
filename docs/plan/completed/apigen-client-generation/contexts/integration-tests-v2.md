# integration-tests-v2 — STATE_NAME

**Phase:** v2-verify · **Kind:** work · **Depends on:** unified-cli, gateway, conformance-vectors, audit-v2-projection, audit-v2-harness, audit-v2-core, streaming-projection, class-exports, audit-v2-host · **Guard:** `npx --yes nx test apigen-cli`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/apigen/cli/src/test/integration/canonical.spec.ts", "packages/apigen/cli/src/test/integration/export-shape-matrix.spec.ts", "packages/apigen/cli/src/test/integration/gateway-mixed-host.spec.ts", "packages/apigen/cli/src/test/fixtures/shapes/named.ts", "packages/apigen/cli/src/test/fixtures/shapes/renamed.ts", "packages/apigen/cli/src/test/fixtures/shapes/default-fn.ts", "packages/apigen/cli/src/test/fixtures/shapes/default-object.ts", "packages/apigen/cli/src/test/fixtures/real-api.ts", "packages/apigen/cli/src/test/fixtures/shapes/anonymous-default.ts", "packages/apigen/cli/src/test/fixtures/shapes/cjs-source.cts", "packages/apigen/cli/src/test/integration/streaming.spec.ts", "packages/apigen/cli/src/test/e2e/real-consumer.spec.ts"]
```

---

## Notes for executor

Re-authored against the canonical contract (SPEC §15). REAL components: extractor->descriptor->harness->each transport. Export-shape matrix (named/renamed-as/default-fn/default-object/anonymous/CJS) proves F28/F29 closed. Mixed-host gateway test proves §13. real-api.ts retained as the v1 behavioral-regression fixture (dod.1/2/5/cli).
