# projection-transports — STATE_NAME

**Phase:** v2-projection · **Kind:** work · **Depends on:** plugin-interface, layer-harness, naming-helpers, error-taxonomy · **Guard:** `npx --yes nx run-many -t test -p apigen-plugin-api-fastify apigen-plugin-api-express apigen-plugin-mcp apigen-plugin-cli`

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
mutates:    ["packages/apigen/plugins/api-fastify/src/lib/generate.ts", "packages/apigen/plugins/api-fastify/src/lib/run.ts", "packages/apigen/plugins/api-express/src/lib/generate.ts", "packages/apigen/plugins/api-express/src/lib/run.ts", "packages/apigen/plugins/mcp/src/lib/generate.ts", "packages/apigen/plugins/mcp/src/lib/run.ts", "packages/apigen/plugins/cli/src/lib/generate.ts"]
```

---

## Notes for executor

SPEC §5/§7/§9: re-cast http-fastify/http-express/mcp/cli as TargetCapability plugins projecting the descriptor over the Layer harness; envelope sourced from transport metadata (strict x-<id>-*/x-adhd-*), not body; canonical projection (POST action / GET query, MCP _ join, CLI nested kebab).
