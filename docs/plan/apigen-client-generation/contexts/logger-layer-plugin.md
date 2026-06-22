# logger-layer-plugin — STATE_NAME

**Phase:** v2-projection · **Kind:** work · **Depends on:** plugin-interface, layer-harness · **Guard:** `npx --yes nx test apigen-plugin-logger`

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
mutates:    ["packages/apigen/plugins/logger/src/lib/plugin.ts", "packages/apigen/plugins/logger/project.json"]
```

---

## Notes for executor

SPEC §7.2(a)/O13: convert v1 createLogger into a LayerCapability plugin (the dogfood Layer) reading typed ctx.get(Logger); per-request timing/ok/fail.
