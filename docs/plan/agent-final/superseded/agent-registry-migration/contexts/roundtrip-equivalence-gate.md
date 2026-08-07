# roundtrip-equivalence-gate — THE GATE: import → compile → normalized diff == empty

**Phase:** verify · **Kind:** work · **Depends on:** import-pipeline, skills-migration · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts`

---

## Goal

THE headline gate. `verifyEquivalence(db, mdPath)` imports a fixture agent, runs
the REAL `agent-registry compile <slug> --platform claude_code`, normalizes both
the compiled output and the original `.md`, and diffs them. An empty diff = `PASS`
for that agent. `buildReport(...)` aggregates per-agent results into an
`equivalence-report` (per-agent `PASS`/`FAIL`) that the removal phase consumes.
Proves `[dod.1]`; produces the artifact that gates `[dod.4]`.

---

## Semantic Distillation

- **Primitive:** ADD `src/verify/equivalence-gate.ts` + `src/verify/normalize.ts`
  + `roundtrip-equivalence.test.ts`.
- **Reference Pattern:** `[def:round-trip]`, `[def:equivalence-report]`,
  `[inv:real-deps-not-mocks]`. SEED_DATA §0 steps 7-8.
- **Delta Spec:**
  - `normalize.ts` — apply ONLY the normalizations recorded in `decisions.md`
    (trailing-whitespace strip, blank-line-run collapse, frontmatter key order,
    `tools:` list order). Each must be content-preserving by construction.
  - `equivalence-gate.ts`:
    - `verifyEquivalence(db, mdPath)`: `importAgent` → `agent-registry compile
      <slug> --platform claude_code` (REAL `@adhd/agent-compiler`) → `normalize`
      both sides → structural diff. Returns `{ slug, status: "PASS"|"FAIL", diff }`.
    - `buildReport(results)`: `{ entries: [...], allPass: boolean }`. `allPass` is
      the forcing function the removal runbook reads.
  - `roundtrip-equivalence.test.ts` — case `"fixture agent round-trips to
    equivalent markdown"`: import `code-reviewer.md`, compile, normalized-diff vs.
    the original fixture, assert the diff is EMPTY and `status === "PASS"`. Reopen
    the DB first to confirm the import persisted (`[inv:reopen-proves-persistence]`).

---

## Acceptance criteria

- [roundtrip-equivalence-gate.1] import->compile->normalized diff == empty for the fixture agent (round-trip equivalence)
- [roundtrip-equivalence-gate.2] gate drives agent-registry compile <slug> --platform claude_code
- [roundtrip-equivalence-gate.3] equivalence report lists per-agent PASS/FAIL; report blocks removal
- [roundtrip-equivalence-gate.4] corrupt a migrated component -> round-trip diff fails -> gate reports FAIL

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/import/import-agent.ts", "packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md"]
mutates:    ["packages/ai/agent-registry-migration/src/verify/equivalence-gate.ts", "packages/ai/agent-registry-migration/src/verify/normalize.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts"]
```

---

## Commit points

- `feat(agent-registry-migration): round-trip equivalence gate + per-agent report`

## Notes for executor

- `[roundtrip-equivalence-gate.4]` is the TEETH (CLAUDE.md verification standard
  #2). The audit runs `scripts/nc_mutate.mjs` to corrupt a persisted
  `PROMPT_COMPONENT` row, confirms the round-trip test goes RED, then
  `nc_restore.mjs` to restore. AUTHOR both tiny scripts as part of this state so
  the negative control is real — without them, `[dod.1]`/`[dod.4]` prove nothing.
  The audit composes them as: positive passes → mutate → positive MUST fail →
  restore → positive passes again (exit-code gated, deterministic, no sleeps).
- The compiler is REAL (`@adhd/agent-compiler`, plan 5) — do not stub it. If the
  diff is non-empty for a sound reason (compiler intentionally reorders), record
  the normalization in `decisions.md`; never loosen the diff to force a pass.
- This state's report (`allPass`) is the ONLY thing that unblocks `retire()`.
