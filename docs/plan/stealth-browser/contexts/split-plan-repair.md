# split-plan-repair — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py split-plan-repair`
**Executor:** `plan-builder` (amend mode; the plan author, because no orchestrator was running) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The plan machinery reflects the split before any code moves: the migrated runner becomes the library `@adhd/stealth-core-browser`, the search tool is ported onto it as the entrypoint `@adhd/stealth-search` with every apigen and tracing requirement of its CLI and MCP hosts, tracing validation is one agent task that reads the written logs, and five obsolete states are retired.

---

## Semantic Distillation

- **Primitive:** MODIFY the plan sources only: `scripts/{guard.py,guards/*.py,ownership.json,criteria.json,check-guards-red.py,audit_dod.py}`, `dag.json` (through `plan-scaffold.js`), `contexts/*`, the plan documents and `docs/plan/plan-index.json`.
- **Reference Pattern:** `docs/plan/stealth-browser/SPEC-stealth-search.md` ([ref:stealth-search-spec]) sections 1.2 step 6 and 5; the earlier plan-repair commits tagged `[psm:plan-repair]`.
- **Delta Spec:** (1) Retire `surface-hosts`, `tracing-plugin`, `tracing-namespace-proof`, `agent-search-cutover`, `agent-search-relink` (`--amend --type retire-state`, then `remove-state`). (2) Add the amendment states and wire the edges. (3) Introduce the path and project constants in the guard (`CORE_DIR`, `SEARCH_DIR`, `CORE_PROJECT`, `SEARCH_PROJECT`), keep completed-state guards green across the rename, key gate evidence by the code trees (src, bin, manifests) of both packages so the docs states cannot invalidate it. (4) Extend ownership, criteria and the red-proof list. (5) Update SCOPE, README and the approval records to three packages. (6) Rescope `tripwire-reverse-migrate.4` to the projects it touched.
- **Invariants:** [inv:one-new-package] (three packages, each generator-built), [inv:gate-trees], [inv:owned-paths-only], [inv:no-ai-attribution].
- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py split-plan-repair`.

---

## Acceptance criteria

- [split-plan-repair.1] dag.json holds every state of the amendment (split-plan-repair, core-scaffold, core-seam, search-scaffold, search-inventory, search-errors, search-port-providers, search-port-fetch, search-port-engine, search-port-guards, search-verbs, search-tracing, search-hosts, search-usecases, search-examples, tracing-log-validation, search-cutover, consumer-relink) and none of the retired ones (surface-hosts, tracing-plugin, tracing-namespace-proof, agent-search-cutover, agent-search-relink), whose retirement is recorded as `retire-state` entries in state.json amendment_log; there is no `tracing-validation` phase or state.
- [split-plan-repair.2] The wiring matches the amendment: core-scaffold depends on split-plan-repair; search-scaffold on core-scaffold and tripwire-pack; search-hosts on search-verbs, search-tracing and core-seam; tracing-log-validation on search-hosts; search-cutover on search-usecases, search-examples, tracing-log-validation and tripwire-pack; consumer-relink on merge-readiness; gates-first on tests-unit-surface, search-usecases, search-examples, tracing-log-validation and search-cutover; merge-readiness on audit-final and tripwire-reverse-migrate (not on consumer-relink); sp-switch on core-seam; prod-errors, prod-examples and tests-unit-surface on core-seam.
- [split-plan-repair.3] scripts/ownership.json has an entry for exactly the states of dag.json (retired entries removed, new states added) and `scripts/check-disjoint.py` exits 0 (no two concurrent states share a path).
- [split-plan-repair.4] scripts/criteria.json carries exactly the criterion ids that `guard.py --list` registers for the states of dag.json (every marker has a check, every check a marker) and each id's command runs `guard.py <state> --only <id>`.
- [split-plan-repair.5] The plan's own sources agree with three packages: SCOPE.md and README.md name @adhd/stealth-core-browser and @adhd/stealth-search, no longer say 'TWO approved new packages', APPROVAL-split.md exists and quotes the verbatim request (port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search) and the three-package decision, `scaffold.5` and `tripwire-scaffold.5` accept the three project.json files, and `check-guards-red.py` names none of the retired states.
- [split-plan-repair.6] The plan validators pass on the amended plan: `gap-check.js docs/plan/stealth-browser --discover`, `consistency-check.js docs/plan/stealth-browser` and `check-disjoint.py` exit 0, and docs/plan/plan-index.json lists the plan with the new states and mutate_set paths (the corpus verified_at is re-stamped by project-status, not by this state).
- [split-plan-repair.7] Only owned paths changed by [psm:split-plan-repair] commits (the plan scripts, dag.json, contexts, the plan documents and docs/plan/plan-index.json).

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/scripts/", "docs/plan/stealth-browser/dag.json", "docs/plan/stealth-browser/contexts/", "docs/plan/stealth-browser/README.md", "docs/plan/stealth-browser/SCOPE.md", "docs/plan/stealth-browser/USE_CASES.md", "docs/plan/stealth-browser/TOOLS.md", "docs/plan/stealth-browser/APPROVAL.md", "docs/plan/stealth-browser/APPROVAL-split.md", "docs/plan/stealth-browser/APPROVALS.md", "docs/plan/stealth-browser/SPEC-stealth-search.md", "docs/plan/stealth-browser/human-blockers.json", "docs/plan/stealth-browser/references.json", "docs/plan/stealth-browser/interfaces.json", "docs/plan/stealth-browser/DEFERRED.md", "docs/plan/plan-index.json"]
```

---

## Contract Promise

Added: the states `core-scaffold`, `core-seam`, `search-scaffold`, `search-inventory`, `search-errors`, `search-port-providers`, `search-port-fetch`, `search-port-engine`, `search-port-guards`, `search-verbs`, `search-tracing`, `search-hosts`, `search-usecases`, `search-examples`, `tracing-log-validation`, `search-cutover`, `consumer-relink`. Removed: the five retired states. Modified: the narrowed and retargeted states.

---

## Commit points

- [ ] Every plan-file write is committed by explicit path, tagged `[psm:split-plan-repair]`.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
