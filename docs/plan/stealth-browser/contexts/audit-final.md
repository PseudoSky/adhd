# audit-final — AUDIT STATE

**Phase:** release · **Kind:** audit · **Depends on:** readme-rewrite · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`
**Executor:** `architect-reviewer` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

Final audit: every Definition-of-Done clause is proven against the real tree, and every cited reference pattern is checked for conformance.

---

## Semantic Distillation

- **Primitive:** AUDIT the whole branch; WRITE the ticked `docs/plan/stealth-browser/final-review.md`.

- **Reference Pattern:** README Definition of Done; `scripts/guard.py audit-final` checks; references.json.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`. Tick `final-review.md` line by line only after the corresponding check passes. No deferrals.

- **Invariants:** Hold point: nothing advances to merge-readiness while any criterion fails. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-final]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final` — runs every acceptance criterion below (red until the work is done); `--only audit-final.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [audit-final.1] [dod.1] structural: exactly one new package exists, entrypoint/stealth-browser, named @adhd/stealth-browser, built by the generator (scaffold evidence) and parity-clean.

- [audit-final.2] [dod.2] behavioral: `nx run stealth-browser:verify-dist-load` and the e2e library/CLI/MCP surfaces pass on the final tree (gates-rerun evidence all green, tree == HEAD tree).
- [audit-final.3] [dod.3] structural: tracing namespace is `adhd` - singleton never imported, serviceName configured once, every mount carries the plugin (tracing-plugin checks 1,2,3,5 re-run).
- [audit-final.4] [ref:runner-port] behavior-preserving port conforms to agent-browser/adhd (exports, similarity, tokens)
- [audit-final.5] [dod.5] structural: the live agent-search source tree is byte-identical to the scaffold-time baseline (cutover is the only state allowed to change it, and it runs after this audit).
- [audit-final.6] [dod.6] structural: one blind review round, every finding resolved by one implementer, gates re-run green after resolution.
- [audit-final.7] [dod.7] structural: docs marketing run PASS, README rewrite receipts-backed (docs-marketing-run and readme-rewrite checks re-run).
- [audit-final.8] [dod.8] structural: the working tree under entrypoint/stealth-browser and docs/plan/stealth-browser is clean (everything committed) and the main checkout node_modules is untouched.
- [audit-final.9] Every spec/e2e file cites ticket 8468f7b1 and a valid criterion id (final re-run of the citation rule).
- [audit-final.ref-backlog-tracing] [ref:backlog-tracing] tracing.ts / usePlugins / no-singleton conformance with entrypoint/backlog/src/tracing.ts
- [audit-final.ref-entrypoint-structure] [ref:entrypoint-structure] top-level files, tags, package metadata conform to dispatch-cli/backlog/apigen-cli
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/final-review.md"]
```

---

## Contract Promise

Modified: `final-review.md`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:audit-final]`:

- [ ] After the audit passes -- commit: `docs(stealth-browser): final audit [psm:audit-final]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Criterion ids `audit-final.ref-*` are the reference-pattern audit checks cited from references.json.
