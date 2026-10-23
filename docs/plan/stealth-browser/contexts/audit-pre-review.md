# audit-pre-review — AUDIT STATE

**Phase:** verify · **Kind:** audit · **Depends on:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, mig-docs, tests-use-cases, search-hosts, search-usecases, search-examples, tracing-log-validation, search-cutover, release-readiness · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-pre-review`
**Executor:** `code-reviewer` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

One non-blind static audit of the finished migration (library, hosts, tracing, use-case suites, the agent-search cutover and the docs the package already carries) runs BEFORE the one blind review, so the blind reviewer is not spent on defects a careful read finds. The result is a machine-readable findings file plus the verbatim output of `audit_dod.py --phase pre-review`.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/review/PRE-REVIEW.json` and `review/PRE-REVIEW.md`. No source edits.

- **Reference Pattern:** `scripts/audit_dod.py` (`--phase pre-review` prints `dod.N` lines for the clauses available before the gates), `docs/plan/stealth-browser/review/` (the later blind review artifacts), `PRODUCT-REVIEW.md`.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/audit_dod.py --phase pre-review` and record its command, integer exit status and verbatim `dod.N` lines. Read the diff of `packages/stealth/stealth-core-browser` and `entrypoint/stealth-search` against `main` plus the cutover diff in the scratch repo and record findings `{id: P1.., severity: blocker|major|minor|nit, file, line, summary, evidence}` (or `no_findings: true` with a rationale of at least 40 characters). Fields `auditor`, `blind: false`, `static: true`, `head` and `tree` (the combined code-tree sha of the core and search packages, `tree_sha` in guard.py) are required. You are not blind: this audit may use the plan, the scope and the catalog. Do not fix anything.

- **Invariants:** [inv:pre-review-not-blind] (this audit is explicitly not the blind review) [inv:greenfield] [inv:typed-errors]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-pre-review]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-pre-review` — runs every acceptance criterion below (red until the work is done); `--only audit-pre-review.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-pre-review --only audit-pre-review.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [audit-pre-review.1] review/PRE-REVIEW.json exists and records `auditor`, `blind: false`, `static: true`, the audited `head` and `tree` (the combined stealth-core-browser + stealth-search code tree, `tree_sha`), the `audit_dod` command, its integer `audit_dod_exit` and the verbatim `dod.N` lines it printed; PRE-REVIEW.md is the human-readable rendering.
- [audit-pre-review.2] The audit judged the current code: `tree` in PRE-REVIEW.json equals the current combined core + search code tree sha, and `audit_dod_exit` equals the exit status of re-running `audit_dod.py --phase pre-review` now.
- [audit-pre-review.3] Every finding has id (P1..), severity in {blocker,major,minor,nit}, file, line, summary and evidence; or `no_findings: true` with a rationale of at least 40 characters; ids are unique and every cited file exists.
- [audit-pre-review.4] The auditor changed no source: [psm:audit-pre-review] commits touch only review/PRE-REVIEW.json and review/PRE-REVIEW.md, and the package tree is identical to its tree at state start.
- [audit-pre-review.5] The pre-review audit checks the inventory: every failsafe-inventory row is pinned now and PRE-REVIEW.json records `inventory_rows` (the row count) and `inventory_unpinned: 0`.

---

## Reservations

```text
read_only:  ["packages/stealth/stealth-core-browser/", "entrypoint/stealth-search/", "/Users/nix/dev/ai/scratch/agent-browser/"]
mutates:    ["/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.json", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.md"]
```

---

## Contract Promise

Added: `review/PRE-REVIEW.json`, `review/PRE-REVIEW.md`. Modified: none. Deleted: none. The package tree is identical before and after.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:audit-pre-review]`:

- [ ] After the audit — commit: `docs(stealth-browser): pre-review audit [psm:audit-pre-review]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The findings feed `audit-fixes` (ONE implementer). Findings you reject belong in the file with evidence, not silence.
- Severity guide: blocker = wrong behaviour or a failed DoD clause; major = a defect a user hits; minor = a gap with a workaround; nit = style.
- The blind review later receives only the diff and the word `Review`; nothing from this audit is forwarded to it.
