# scaffold-v2-ts-plugins — STATE_NAME

**Phase:** v2-scaffold · **Kind:** work · **Depends on:** scaffold-plugins, nx-generator-v2 · **Guard:** `npx --yes nx run-many -t build -p apigen-plugin-logger apigen-plugin-openapi apigen-plugin-health`

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
mutates:    ["packages/apigen/plugins/logger/project.json", "packages/apigen/plugins/openapi/project.json", "packages/apigen/plugins/health/project.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
