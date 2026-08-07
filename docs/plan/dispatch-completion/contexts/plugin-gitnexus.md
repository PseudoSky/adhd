# plugin-gitnexus — STATE_NAME

**Phase:** plugins · **Kind:** work · **Depends on:** orch-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-plugin-gitnexus`

---

## Goal

`@adhd/dispatch-plugin-gitnexus` runs a blast-radius enrichment pass between snapshot() and optimize(), populating `blast_radius` on ops by wrapping the repo's GitNexus MCP.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [plugin-gitnexus.1] dispatch-plugin-gitnexus builds+tests green

- [plugin-gitnexus.2] plugin-gitnexus package entry exists
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-plugin-gitnexus/src/index.ts"]
```

---

## Notes for executor

New package (node). Reuse the existing GitNexus MCP (`gitnexus_impact`/`gitnexus_context`) — do not reimplement AST analysis. Teeth (dod.7): a high-fan-in op carries non-null blast_radius; null-injection stays valid. [inv:layer-purity].
