# package-restructure — STATE_NAME

**Phase:** v2-packaging · **Kind:** work · **Depends on:** projection-transports, mount-plugins, error-taxonomy, naming-helpers, conformance-vectors · **Guard:** `npx --yes nx run-many -t build -p apigen-core apigen-naming apigen-errors apigen-schema apigen-conformance apigen-gateway`

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
mutates:    ["packages/apigen/core/project.json", "packages/apigen/naming/project.json", "packages/apigen/errors/project.json", "packages/apigen/schema/project.json", "packages/apigen/conformance/project.json", "packages/apigen/gateway/project.json"]
```

---

## Notes for executor

SPEC §12: split COMMON (core/naming/errors/schema/conformance/gateway + neutral codegen/*) vs PER-LANGUAGE ts/* (-core,-extractor,-runtime,plugins as apigen-ts-plugin-*). Rule: descriptor-in/artifact-out=common; touches host fns/runtime=per-language.
