# scaffold-v2-common — STATE_NAME

**Phase:** v2-scaffold · **Kind:** work · **Depends on:** core-types · **Guard:** `npx --yes nx run-many -t build -p apigen-naming apigen-errors apigen-schema apigen-conformance apigen-gateway apigen-codegen-openapi`

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
mutates:    ["packages/apigen/naming/project.json", "packages/apigen/errors/project.json", "packages/apigen/schema/project.json", "packages/apigen/conformance/project.json", "packages/apigen/gateway/project.json", "packages/apigen/codegen/openapi/project.json"]
```

---

## Notes for executor

SPEC §12: scaffold the 6 COMMON packages in their final homes with full nx wiring (tsconfig.base paths, vite.config, tsconfig.lib/spec, layer:logic/platform:shared tags) — mirrors v1 scaffold-packages. Fixes R3 (unscaffolded pkgs) + R6 (final homes → package-restructure becomes a verify gate). apigen-schema gets its owning state here.
