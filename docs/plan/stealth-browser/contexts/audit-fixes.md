# audit-fixes — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** audit-pre-review · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-fixes`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every pre-review finding is fixed or rejected with evidence by ONE implementer, so the blind review sees a tree that already survived a careful read. The corrected tree passes lint, typecheck, typecheck-spec and the unit lane, and `audit_dod.py --phase pre-review` exits 0.

---

## Semantic Distillation

- **Primitive:** MODIFY whatever the findings cite inside `entrypoint/stealth-browser/` (and the owned cutover consumer files in the scratch repo); CREATE `review/PRE-REVIEW-RESOLUTION.json`.

- **Reference Pattern:** `review/PRE-REVIEW.json` (the findings), `scripts/audit_dod.py`, `docs/plan/stealth-browser/review/` conventions of `resolve-findings`.

- **Delta Spec:** `PRE-REVIEW-RESOLUTION.json` has one `agent` value and one resolution per finding id: `fixed` (with the `[psm:audit-fixes]` commit sha that touches the cited file) or `rejected` (with at least 40 characters of evidence and a reproduction command). Nothing is left open or deferred. One implementer, one git author for every `[psm:audit-fixes]` commit. No new TODO/FIXME/XXX.

- **Invariants:** [inv:one-implementer] [inv:greenfield] [inv:typed-errors] [inv:esm-js-specifiers] [inv:unit-purity]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-fixes]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-fixes` — runs every acceptance criterion below (red until the work is done); `--only audit-fixes.N` runs one. Re-run `audit_dod.py --phase pre-review` last.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-fixes --only audit-fixes.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [audit-fixes.1] review/PRE-REVIEW-RESOLUTION.json covers 100% of PRE-REVIEW finding ids (or records `no_findings: true` when the audit had none); every finding is `fixed` or `rejected` - none open or deferred.
- [audit-fixes.2] Each `fixed` entry names a commit sha tagged [psm:audit-fixes] that touches the cited file; each `rejected` entry carries >=40 chars of evidence and a reproduction command.
- [audit-fixes.3] ONE implementer corrected every finding: PRE-REVIEW-RESOLUTION.json has a single `agent` value and all [psm:audit-fixes] commits share one git author.
- [audit-fixes.4] No new TODO/FIXME/XXX in entrypoint/stealth-browser/src and only owned paths changed by [psm:audit-fixes] commits.
- [audit-fixes.5] After the corrections lint, typecheck, typecheck-spec and the unit lane exit 0 (`nx run stealth-browser:lint typecheck typecheck-spec test`); the full gate run follows in gates-first.
- [audit-fixes.6] `audit_dod.py --phase pre-review` exits 0 on the corrected tree (every dod clause that was available before the gates now passes).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/review/PRE-REVIEW.json"]
mutates:    ["entrypoint/stealth-browser/", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW-RESOLUTION.json", "/Users/nix/dev/ai/scratch/agent-browser/adhd/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/cdp-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/chrome-lifecycle-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/network-capture.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-challenge.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-dom.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-fetch.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-guard-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-network.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/activity.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/context.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/last-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/package.json", "/Users/nix/dev/ai/scratch/agent-browser/AGENTS.md", "/Users/nix/dev/ai/scratch/agent-browser/SEARCH.md", "/Users/nix/dev/ai/scratch/agent-browser/FEATURES.md", "/Users/nix/dev/ai/scratch/agent-browser/FETCH.md", "/Users/nix/dev/ai/scratch/agent-browser/docs/", "packages/resilience/resilience-core-tripwire/"]
```

---

## Contract Promise

(Also may fix the second approved package under `packages/resilience/resilience-core-tripwire/` when a finding concerns it; the same one implementer resolves it, [inv:one-implementer].)

Modified: files cited by findings. Added: `review/PRE-REVIEW-RESOLUTION.json`. Deleted: only what a finding calls dead.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:audit-fixes]`:

- [ ] Per finding, or per tightly related group — commit: `fix(stealth-browser): <finding ids> [psm:audit-fixes]`
- [ ] After the resolution file — commit: `docs(stealth-browser): pre-review resolution [psm:audit-fixes]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Do not re-run or edit `PRE-REVIEW.json`; it is the auditor's record.
- A rejected finding needs a reproduction command that shows the claimed defect does not exist.
