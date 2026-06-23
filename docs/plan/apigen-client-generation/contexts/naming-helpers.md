# naming-helpers — STATE_NAME

**Phase:** v2-core · **Kind:** work · **Depends on:** canonical-descriptor, scaffold-v2-common · **Guard:** `npx --yes nx test apigen-naming`

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
mutates:    ["packages/apigen/naming/src/lib/naming.ts", "packages/apigen/naming/project.json"]
```

---

## Notes for executor

SPEC §5: @adhd/apigen-naming — tokenizer + toKebab/toPascal/toSnake/toCamel + per-transport projection (HTTP kebab, MCP _, gRPC Pascal, CLI kebab); file-name normalize; default/default-object/index rules.
