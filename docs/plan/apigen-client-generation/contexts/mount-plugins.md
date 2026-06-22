# mount-plugins — STATE_NAME

**Phase:** v2-projection · **Kind:** work · **Depends on:** plugin-interface, naming-helpers · **Guard:** `npx --yes nx run-many -t test -p apigen-openapi apigen-plugin-openapi apigen-plugin-health`

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
mutates:    ["packages/apigen/codegen/openapi/src/lib/to-openapi.ts", "packages/apigen/plugins/openapi/src/lib/plugin.ts", "packages/apigen/plugins/health/src/lib/plugin.ts"]
```

---

## Notes for executor

SPEC §7.2(b,c)/§12: MountCapability plugins. @adhd/apigen-openapi = neutral descriptor->OpenAPI content (common); thin per-host openapi + health mount plugins add _meta/openapi and _meta/health operations that flow through the harness.
