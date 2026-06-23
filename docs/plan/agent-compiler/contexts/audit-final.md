# audit-final — PROVE EVERY [dod.N] THROUGH ITS REAL ENTRYPOINT

**Phase:** audit · **Kind:** audit · **Depends on:** compile-fixtures-e2e · **Guard:** `python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase final`

---

## Goal

The whole plan's Definition of Done is proven: every `[dod.N]` check executes its
real entrypoint and produces its named observable, and every prior-phase check is
still green. This is the acceptance gate.

---

## Semantic Distillation

- **Primitive:** RUN `audit_compiler.py --phase final`. It runs `phase_schema()`
  plus the behavioral DoD checks, each driving the clause's declared entrypoint:
  - `[dod.1]`/`[dod.2]`/`[dod.3]` drive `compile-e2e.test.ts` (frontmatter `tools:`
    + junction order; context-conditional inclusion; policy constraint);
  - `[dod.4]` drives `compile-cache.test.ts` (cache hit after reopen);
  - `[dod.5]` drives `compile-cli.test.ts` (real CLI bin stdout);
  - `[dod.6]`/`[dod.7]` structural greps (platform:node + four deps + path; writes
    `composed_prompts`; both `yaml_frontmatter` + `json_object` emitters).
- `state-transition.js` will not advance to `done` unless every `[dod.N]` shows an
  executed PASS (exit 4 `dod_unconfirmed` otherwise).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] final audit passes: every prior-phase + DoD check green

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-compiler/scripts/audit_compiler.py"]
```

---

## Commit points

- `chore(agent-compiler): final audit green — DoD proven`

## Notes for executor

- DoD checks must DRIVE the real test entrypoints — the command strings literally
  name `--testFile=...compile-e2e.test.ts` / `compile-cache.test.ts` /
  `compile-cli.test.ts` so the proof is the real interaction, not a proxy.
- Confirm the negative controls bite before declaring done: revert each fix (drop
  `ORDER BY position`; ignore platform in tools; bypass context; return empty
  policy constraints; skip the cache SELECT; ignore `--platform`) and confirm the
  relevant test goes red, then restore (CLAUDE.md verification standard #2).
- The headline `[dod.1]` is the one the team-lead called out — it must drive the
  REAL engine against REAL rows and assert the frontmatter `tools:` + junction
  order, not a mock or a shape check.
