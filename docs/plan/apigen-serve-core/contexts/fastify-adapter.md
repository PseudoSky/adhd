# fastify-adapter — STATE_NAME

**Phase:** phase-1 · **Kind:** work · **Depends on:** serve-core-primitives, parity-harness · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-api-fastify:test`

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
mutates:    ["packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/generate.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/route-projection.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/stream.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/plugin.spec.ts", "packages/apigen/apigen-plugin-api-fastify/src/test/golden/fastify.snapshot.json"]
```

---

## Notes for executor

Reference TransportAdapter migration. Fold DEBT-004 mount fidelity + wire dead sendStreamSse live. Parity gate + negative control.
