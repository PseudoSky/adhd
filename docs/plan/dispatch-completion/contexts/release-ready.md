# release-ready — STATE_NAME

**Phase:** release · **Kind:** work · **Depends on:** test-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-base-spec,dispatch-core-client,dispatch-serializer-json,dispatch-serializer-sqlite,dispatch-core-optimizer,dispatch-orchestrator,dispatch-plugin-io,dispatch-plugin-gitnexus,dispatch-tools,dispatch-cli`

---

## Goal

All ten dispatch projects build+test green (twice = cache-proven), versions bump 0.0.1→0.1.0, the plan BACKLOG is fully closed, and the portfolio links are updated — release-ready.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [release-ready.1] all 10 dispatch projects build+test green

---

## Reservations

```text
read_only:  []
mutates:    ["package.json"]
```

---

## Notes for executor

Terminal work state. Human-gated `nx release publish` is a follow-on (out of scope). Reconcile BACKLOG.md (every row closed, no `status: OPEN` — dod.13 forcing function). [inv:nx-cache].
