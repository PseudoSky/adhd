# builder-engine — STATE_NAME

**Phase:** builder · **Kind:** work · **Depends on:** contract-base-spec · **Guard:** `true`

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
mutates:    ["packages/environment/environment-builder/src/yaml-parser.ts", "packages/environment/environment-builder/src/field-merge.ts", "packages/environment/environment-builder/src/config-resolver.ts", "packages/environment/environment-builder/src/json-schema-gen.ts", "packages/environment/environment-builder/src/provenance.ts", "packages/environment/environment-builder/src/validation.ts", "packages/environment/environment-builder/src/snapshot-writer.ts", "packages/environment/environment-builder/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
