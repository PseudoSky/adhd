# streaming-projection — STATE_NAME

**Phase:** v2-projection · **Kind:** work · **Depends on:** projection-transports, layer-harness, error-taxonomy · **Guard:** `npx --yes nx run-many -t test -p apigen-plugin-mcp apigen-plugin-api-fastify apigen-runtime`

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
mutates:    ["packages/apigen/runtime/src/lib/stream.ts", "packages/apigen/plugins/mcp/src/lib/stream.ts", "packages/apigen/plugins/api-fastify/src/lib/stream.ts"]
```

---

## Notes for executor

SPEC §11 (D6 full streaming now): streaming:true -> async stream; Layer stream-lifecycle (start/each/end/error) per §8.1; consumer-pull backpressure; signal cancellation runs the end path; error-after-first-chunk delivered in-band per the §11 table (SSE event:error / gRPC trailing status / MCP progressive error / CLI stderr+exit) adopting Connect's semantics.
