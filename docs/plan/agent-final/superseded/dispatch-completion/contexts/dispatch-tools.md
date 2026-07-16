# dispatch-tools — STATE_NAME

**Phase:** tools · **Kind:** work · **Depends on:** opt-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-tools`

---

## Goal

`@adhd/dispatch-tools` exposes MCP tools (`dag.milestone_add`/`pending_clear`) that author a valid dag through `DagClient` and reject cycle-forming edits.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [dispatch-tools.1] dispatch-tools builds+tests green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-tools/src/index.ts"]
```

---

## Notes for executor

Phase-0-gated: if EXEC-001 already shipped the full dispatch-tools package (its execution primitives), narrow this to any authoring-API gap or drop entirely (triage decides). DagClient is the sole CRUD authority ([inv:adapter-pattern], P2). Teeth (dod.11): tool-authored dag validates; a cycle-forming add is rejected and the dag is unchanged.
