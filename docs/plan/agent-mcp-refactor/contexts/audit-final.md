# audit-final — acceptance gate

**Phase:** audit · **Kind:** audit · **Depends on:** session-e2e · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase final`

---

## Goal

The acceptance gate for the whole plan: under `--phase final` every criterion
plus the six behavioral/structural DoD checks (`[dod.1..6]`) emit a `PASS` line
and the script exits 0 — proving the session-start path resolves the system prompt
from the compiler, the cache reuses on a second session, the flat-systemPrompt
authoring path is gone, the runtime sink schema + compiler dependency landed, the
claudecli tool model is reconciled, and the full agent-mcp suite is non-regressed.

This is an audit state — it carries NO deferrable items and makes NO code change.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] final-phase audit self-consistent (all criteria + DoD checks accumulate green)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py"]
```

---

## Notes for executor

- Run `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase
  final`; it must exit 0 and print a `[dod.N] PASS` line for each of dod.1..6.
- The behavioral DoD checks DRIVE real vitest entrypoints — gate on the script's
  EXIT CODE (`[inv:exit-code-gate]`), never a stdout grep.
- Acceptance: the requesting engineer accepts via this gate; `architect-reviewer`
  reviewed `decisions.md` at `refactor-design` (Execution model).
