# Spec 69a8b83b (+ cc5a4906) — dispatcher topic anchor / side-ask classification, and git-manager adoption

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 69a8b83b-c9aa-440b-b1c5-26d21d97c95f (feature, HIGH, project claude-agents); cc5a4906-40f2-4d0f-a7fe-6b90e2bf5742 (feature, HIGH, project sox-ecosystem). Bucketed because both change `extensions/agents/dispatcher/dispatcher.md` (rule 8 / rule 23 / Step 0).
dor: needs-decision — check: (1) which repo owns the dispatcher (item says claude-agents; a newer v2.1.0 copy lives in sox-ecosystem), (2) what a non-trivial side-ask is allowed to skip, (3) whether git-manager owns ALL git or only conflicts. Size: S (prose + tests), XS for the cc5a4906 residual.

## Observed facts (O = opened)
- O: dispatcher exists in two repos. Newer: `/Users/nix/dev/ai/sox-ecosystem/extensions/agents/dispatcher/dispatcher.md` (package.json 2.1.0, CHANGELOG "Unreleased" pending; tests in `extensions/agents/dispatcher/tests/*.test.mjs`). Older: `/Users/nix/dev/ai/claude-agents/categories/dispatch/agents/dispatcher.md` (what 69a8b83b cites as `:120/:44-48`; those lines no longer match; no "side-ask"/"main topic" hits in either).
- O: the trivial-path half is DONE (cf4b08e3 resolved): sox dispatcher rule 8 defines a *trivial bucket* (single observable fact; one dispatch, one direct read, no static review/QA/control test, declared in the report), `dispatcher.md:111-134`. Remaining for 69a8b83b = topic anchor + on-topic/side-ask classification only.
- O: run identity is minted at Step 0.2 (`dispatcher.md:406-410`), Inputs line 327; rule 0 (explicit user direction wins) at lines 41-57; rule 20 requires ACs cited by tests even for trivial buckets.
- O: cc5a4906 is largely DELIVERED: `extensions/agents/git-manager/` exists at 0.4.1 (extension.json, git-manager.md, README, CHANGELOG; claude/opencode/agent-mcp/codex hosts), and `/Users/nix/dev/ai/sox-ecosystem/docs/GIT-POLICY.md` exists ("Established 2026-09-29; not yet adopted"). `docs/contributing/conventions/git-workflow.md` and an agent named `git-operator` were superseded by those. Dispatcher rule 23 already routes merge conflicts to `git-manager` (`dispatcher.md:249-256,431`).
- O: residuals true today: `AGENTS.md`/`CONTRIBUTING.md` in sox-ecosystem contain no pointer to GIT-POLICY.md (rg found none). Owner directive (item enrichment 2026-09-26): "Every git operation... is performed by this agent; nobody else runs git" CONFLICTS with rule 23 ("You run the lifecycle's git; git-manager resolves merge conflicts").
- R (item, not re-verified): leakage test, A/B and four-check post-install verification of git-manager were still open on 2026-09-26; CHANGELOG 0.3.x-0.4.1 shows installs but no A/B record was found.
- ADRs: sox 0026 (agents reference capabilities, never tool names) governs wording; sox 0013 (no env feature switches).

## Design decisions
D1 Anchor: Step 0.1 ("restate the direction in one sentence") additionally records `Main topic: <project/plan/area, one line>`; it is carried in every run line / report header and revisited only when the user redirects. Stored in the run's backlog plan item or first Task entry, not a new file (rule 27: resume from the backlog alone).
D2 Classification line (one line per ask, never withheld): `ask-class: on-topic | side-ask — <reason>`. On-topic = full lifecycle. Side-ask = unrelated to the anchor.
D3 (DECISION) What a side-ask skips. Recommended: classification only selects ceremony *within* the existing rule-8 trivial bucket: a side-ask whose done-state is a single observable fact takes the trivial path; a side-ask with a larger done-state does NOT skip rule 4/5 (still gets its own bucket + review) but does not wait on the main topic's plan. Rejected: "side-ask => no review gate regardless of size" (the item's wording) — it lets a large unreviewed change bypass rules 4/5/20 by being labeled a side-ask.
D4 Rule 0 guard (hard): classification may never redirect, defer, re-scope or refuse; an explicit user request for full ceremony on a side-ask is honored; the line is auditable.
D5 (DECISION) git ownership. Options: (a) keep rule 23 (dispatcher runs lifecycle git, git-manager resolves conflicts) and close cc5a4906 as delivered; (b) honor the owner directive: dispatcher delegates ALL git (worktree create/remove, merges, push) to git-manager — larger change to rules 5, 22, 23 and Step 5/7. Recommend (a) unless the owner reaffirms the directive; if (b), spec a follow-up.
D6 Adoption (ready under either D5): add one-line pointers to GIT-POLICY.md from sox-ecosystem `AGENTS.md` and `CONTRIBUTING.md`; flip GIT-POLICY.md status line to adopted; run the git-manager leakage test + A/B + install verification already listed in the item and record them in `extensions/agents/git-manager/CHANGELOG.md`.

## Write-scope (exact; sox-ecosystem repo, absolute)
- /Users/nix/dev/ai/sox-ecosystem/extensions/agents/dispatcher/dispatcher.md (Step 0.1, rule 8 paragraph, report header; if D5(b) also rules 22-23)
- /Users/nix/dev/ai/sox-ecosystem/extensions/agents/dispatcher/CHANGELOG.md (+ version via Changesets flow, README.md if it lists rules)
- /Users/nix/dev/ai/sox-ecosystem/extensions/agents/dispatcher/tests/ (new `topic-anchor.test.mjs`; extend `step-headings.test.mjs` only if headings change)
- /Users/nix/dev/ai/sox-ecosystem/AGENTS.md, CONTRIBUTING.md, docs/GIT-POLICY.md (D6)
- /Users/nix/dev/ai/sox-ecosystem/extensions/agents/git-manager/CHANGELOG.md (evidence of A/B)
- If the owning repo is decided to be claude-agents: same edits against `categories/dispatch/agents/dispatcher.md`; do not edit both (ADR-0002: fix at source, no duplicate).

## Acceptance criteria
- AC1 Step 0 requires a one-line main topic and the run line/report header carries it.
- AC2 Every ask after the first is classified `on-topic` or `side-ask` in one stated line with a reason.
- AC3 A side-ask that is a trivial bucket takes the existing trivial path and the report says so; a side-ask that is not trivial still gets rules 4/5/20.
- AC4 Text states classification never redirects/defers/re-scopes, and an explicit user request for full ceremony is honored.
- AC5 No rule number is renumbered; `step-headings.test.mjs` and `routing-rows.test.mjs` still pass.
- AC6 (cc5a4906) AGENTS.md and CONTRIBUTING.md point to GIT-POLICY.md and its status reads adopted.
- AC7 (cc5a4906) A leakage test, an A/B against baseline, and post-install verification on each declared host are recorded for git-manager.
- AC8 (cc5a4906, only if D5(b)) dispatcher rule 23 and Steps 5/7 route all git to git-manager.

## Test plan (tier S default; cite `69a8b83b AC<n>` / `cc5a4906 AC<n>`)
AC1-AC5: S, node `--test` static assertions over dispatcher.md (rule text present, no renumbering, forbidden phrases like "refuse"/"defer" absent from the classification paragraph) — pattern of existing `tests/*.test.mjs`; plus one behavior A/B (cheapest-tier model, blind) over three asks: on-topic, one-line side-ask, large side-ask; assert classification line and ceremony per AC3. The A/B is tier P-like evidence recorded in the CHANGELOG, not a CI lane. AC6: S file-content check. AC7: manual evidence artifacts (agent-authoring pipeline; tier X-equivalent, no CI). AC8: as AC1-5.

## Risks / serialization
- Both items edit dispatcher.md: one implementer, one worktree. sox-ecosystem tree is dirty (memory-server, host-runtime, install-engine) — use a worktree under `.worktrees/`. Prose-only agents: version bump via Changesets (do not hand-edit package.json version).
- Open for product/user: D3 (side-ask ceremony), D5 (git ownership), owning repo for the dispatcher.

## Product revision
dor (product): needs-user for two material choices (owning repo; git ownership). One decision is resolved here.
Resolved by product: D3 accepted as recommended. A side-ask whose done-state is a single observable fact takes the existing rule-8 trivial path; a larger side-ask still gets rules 4/5/20 and does not wait on the main topic. The item's wording ("side-ask => no review gate regardless of size") is rejected because it lets a large unreviewed change bypass review by labelling. D1, D2, D4 (rule 0 guard) and D6 (adoption pointers) accepted unchanged.
Not decided (user): (1) repo that owns the dispatcher (sox-ecosystem 2.1.0 vs claude-agents copy), (2) git ownership D5(a) vs (b). Product recommendation: sox-ecosystem owns it (newer, tested, Changesets flow); D5(a) keep rule 23 and close cc5a4906 as delivered once D6/AC6/AC7 land, because (b) is a larger rewrite of rules 5, 22, 23 and Steps 5/7 with no incident behind it, while the owner directive's literal wording conflicts with rule 23 and needs the owner to reaffirm or retire it.
Cuts if the user wants speed: AC1-AC5 and AC6 are independent of D5; AC8 only if (b).
Priority: P3, rank 10 (prose-only; the trivial-path half already shipped; no live incident).
