# audit-final — AUDIT STATE

**Phase:** release · **Kind:** audit · **Depends on:** readme-rewrite · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`
**Executor:** `architect-reviewer` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Final audit: every Definition-of-Done clause is proven against the real tree, and every cited reference pattern is checked for conformance.

---

## Semantic Distillation

- **Primitive:** AUDIT the whole branch; WRITE the ticked `docs/plan/stealth-browser/final-review.md`.

- **Reference Pattern:** README Definition of Done; `scripts/guard.py audit-final` checks; references.json.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`. Tick `final-review.md` line by line only after the corresponding check passes. No deferrals. The audit covers both approved packages: `[dod.1]` names `@adhd/stealth-browser` and `@adhd/resilience-core-tripwire`, and `[ref:tripwire-core]` (audit-final.13) checks the tripwire package's zero dependencies, CJS-only manifest, TW31 purity and documentation.

- **Invariants:** Hold point: nothing advances to merge-readiness while any criterion fails. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-final]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final` — runs every acceptance criterion below (red until the work is done); `--only audit-final.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [audit-final.1] [dod.1] structural: only the approved new packages exist: entrypoint/stealth-browser named @adhd/stealth-browser (built by the generator, parity-clean) and packages/resilience/resilience-core-tripwire named @adhd/resilience-core-tripwire (built by the generator, tripwire-scaffold evidence).
- [audit-final.2] [dod.2] behavioral: `nx run stealth-browser:verify-dist-load` and the use-case unit suites (library, CLI and MCP scenarios against the in-process fake CDP server) pass on the final tree, and the agent-search cutover proof holds (gates-rerun evidence all green, tree == HEAD tree).
- [audit-final.3] [dod.3] structural: tracing namespace is `adhd` - singleton never imported, serviceName configured once, every mount carries the plugin (tracing-plugin checks 1,2,3,5 re-run).
- [audit-final.4] [ref:runner-port] behavior-preserving port conforms to agent-browser/adhd (exports, similarity, tokens)
- [audit-final.5] [dod.5] structural: the agent-search source tree was byte-identical to the scaffold-time baseline up to the first cutover commit, and only [psm:agent-search-cutover] commits touched agent-browser/adhd afterwards.
- [audit-final.6] [dod.6] structural: one blind review round, every finding resolved by one implementer, gates re-run green after resolution.
- [audit-final.7] [dod.7] structural: docs marketing run PASS, README rewrite receipts-backed (docs-marketing-run and readme-rewrite checks re-run).
- [audit-final.8] [dod.8] structural: the working tree under entrypoint/stealth-browser and docs/plan/stealth-browser is clean (everything committed) and the main checkout node_modules is untouched.
- [audit-final.10] Every spec file cites ticket 8468f7b1 and a valid criterion id (final re-run of the citation rule).
- [audit-final.11] Script-only audit (no reviewer agent): final-review.md records `AUDITOR: audit_dod.py (script-only)` and the verbatim `[dod.1]`..`[dod.8]` PASS lines printed by `audit_dod.py --phase final`, with `EXIT: 0`.
- [audit-final.ref-backlog-tracing] [ref:backlog-tracing] tracing.ts / usePlugins / no-singleton conformance with entrypoint/backlog/src/tracing.ts
- [audit-final.ref-entrypoint-structure] [ref:entrypoint-structure] top-level files, tags, package metadata conform to dispatch-cli/backlog/apigen-cli
- [audit-final.ref-apigen-host] [ref:apigen-host] server.ts / cli.ts / bin hosts mirror entrypoint/backlog's apigen host shape
- [audit-final.ref-runner-port] [ref:runner-port] behavior-preserving port conforms to agent-browser/adhd (exports, similarity, tokens)
- [audit-final.9] (PA10.3, re-checked after the docs states) `npm pack --dry-run` against the final dist output still lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js, index.js and index.d.ts, and the packed README is the rewritten one (it links docs/RESPONSIBLE-USE.md).
- [audit-final.12] [inv:no-features-removed] final re-check: every failsafe-inventory row is still pinned on the final tree and the inventory file is unchanged since failsafe-inventory (rows were never deleted: row count >= the count recorded at inventory time in evidence/failsafe-inventory.json `row_count`).
- [audit-final.13] [ref:tripwire-core] the second approved package conforms: @adhd/resilience-core-tripwire has zero dependencies, CJS-only manifest (no module, no exports, no type), no process.env / process.stdin / child_process / console access in src/lib outside node-io.ts (TW31), README, CHANGELOG, docs/ERRORS.md and docs/RECOVERY.md, no AI attribution line, and the gates-rerun evidence tripwire tree equals the HEAD tripwire tree.

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
