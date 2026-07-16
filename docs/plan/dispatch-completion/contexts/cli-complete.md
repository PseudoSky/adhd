# cli-complete — STATE_NAME

**Phase:** cli · **Kind:** work · **Depends on:** orch-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-cli`

---

## Goal

`dispatch` is npx-invocable (bin field + esbuild build-bin), calibrate rejects a bad tier before constructing the runner, all `*Core` fns report a missing dag file consistently, poll-internal duplicates are deleted, and `dispatch-base-types` is removed.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [cli-complete.1] dispatch-cli builds+tests green

- [cli-complete.2] dispatch-cli declares a bin field
- [cli-complete.3] orphaned dispatch-base-types is deleted
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/dispatch-cli/package.json", "entrypoint/dispatch-cli/project.json", "entrypoint/dispatch-cli/src/lib/core.ts"]
```

---

## Notes for executor

Closes DEBT-022 (bin + esbuild target; decompile's @nx/js:tsc precedent), DEBT-024 (lazy runner factory), DEBT-025 (shared missing-file guard), DEBT-023 (delete cli poll dupes, consume exported POLL_TERMINAL_STATUSES/pollUntilTerminal). Delete orphan `dispatch-base-types` (dod.12). Keep hand-written `bin/cli.ts` canonical; the apigen generated-CLI $ref crash stays deferred (out of scope).
