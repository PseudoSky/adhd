# parity-harness — STATE_NAME

**Phase:** phase-1 · **Kind:** work · **Depends on:** none · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test`

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
read_only:  ["packages/apigen/apigen-core-client/src/lib/plugin.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-plugin-mcp/src/lib/run.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/run.ts"]
mutates:    ["packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.spec.ts"]
```

---

## Notes for executor

Shared golden-fixture parity harness (proposal §6): golden-capture + deep-equal re-capture + negative-control helpers, driving REAL consumer protocols.
