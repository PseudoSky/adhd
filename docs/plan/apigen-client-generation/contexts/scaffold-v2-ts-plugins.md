# scaffold-v2-ts-plugins — STATE_NAME

**Phase:** v2-scaffold · **Kind:** work · **Depends on:** scaffold-plugins · **Guard:** `npx --yes nx run-many -t build -p apigen-ts-plugin-logger apigen-ts-plugin-openapi apigen-ts-plugin-health`

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
mutates:    ["packages/apigen/ts/plugins/logger/project.json", "packages/apigen/ts/plugins/openapi/project.json", "packages/apigen/ts/plugins/health/project.json"]
```

---

## Notes for executor

SPEC §12: scaffold the 3 new TS plugin packages (logger=layer, openapi+health=mount) in final ts/plugins/* homes with nx wiring; platform:node. Fixes R3.
