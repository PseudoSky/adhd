# plugin-io — STATE_NAME

**Phase:** plugins · **Kind:** work · **Depends on:** orch-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-plugin-io`

---

## Goal

`@adhd/dispatch-plugin-io` provides `fileSizes()`/`readFiles()` injected into `IOptimizerDeps`, making `pairwise_overlap` reflect real shared source bytes.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [plugin-io.1] dispatch-plugin-io builds+tests green

- [plugin-io.2] plugin-io package entry exists
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-plugin-io/src/index.ts"]
```

---

## Notes for executor

New package (node platform, `<domain>-<tier>-<name>` standard). Injection seam `IOptimizerDeps` already exists. Teeth (dod.7): with the plugin, overlap is non-zero for file-sharing milestones; with null injection, optimize() still returns valid units (purity). [inv:layer-purity].
