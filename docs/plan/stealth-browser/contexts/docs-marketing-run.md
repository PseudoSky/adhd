# docs-marketing-run — WORK STATE

**Phase:** docs · **Kind:** work · **Depends on:** gates-rerun · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run`
**Executor:** `doc-steward` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

A doc-steward marketing run has made the package documentation correct and receipts-backed: capability catalog, reviewed PASS, AGENTS.md, llms.txt, CHANGELOG with the migration entry, and a README baseline.

---

## Semantic Distillation

- **Primitive:** RUN doc-steward on `entrypoint/stealth-browser/`; WRITE `entrypoint/stealth-browser/docs/**`, `AGENTS.md`, `llms.txt`, `CHANGELOG.md`, `README.md`.

- **Reference Pattern:** `entrypoint/stealth-browser/docs/reference/**`, the built bins, `docs/marketing/.catalog/` produced by the cartographer.

- **Delta Spec:** Dispatch `doc-steward` scoped to `entrypoint/stealth-browser`. It dispatches the cartographer (capabilities.json with a runnable receipt per shipped capability -- the six verbs across library/CLI/MCP), rewrites the doc surface, and gates on doc-reviewer PASS (`docs/marketing/.catalog/review.md`). CHANGELOG gets a `0.0.1` migration entry. Documentation only: no `src/` or `bin/` change (guard checks that the gates-rerun tree is still the source tree).

- **Invariants:** Documentation only; no AI attribution lines in any doc; every claim has a shipped receipt. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:docs-marketing-run]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run` — runs every acceptance criterion below (red until the work is done); `--only docs-marketing-run.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run --only docs-marketing-run.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [docs-marketing-run.1] docs/marketing/.catalog/capabilities.json lists >= 6 `shipped` capabilities (the six verbs) each with a runnable receipt command; no entry lacks a status of shipped|roadmap|deprecated.

- [docs-marketing-run.2] docs/marketing/.catalog/review.md records a doc-reviewer verdict of PASS.
- [docs-marketing-run.3] AGENTS.md, llms.txt, CHANGELOG.md (with a 0.0.1 migration entry) and README.md exist; no AI attribution lines anywhere in them.
- [docs-marketing-run.4] Documentation-only: [psm:docs-marketing-run] commits touch only docs/, README.md, AGENTS.md, llms.txt, CHANGELOG.md (ownership).
- [docs-marketing-run.5] Gate evidence of gates-rerun still matches the package source tree (docs run changed no src/).
- [docs-marketing-run.6] (PA6.2, PA6.3) docs/CONFIGURATION.md lists every default verbatim (port 9222, the Library/Application Support/Google/Chrome-CDP profile, /tmp/stealth-browser-heartbeat) and states macOS-first support with what is untested elsewhere.
- [docs-marketing-run.7] (PA8.1, PA8.2) docs/RESPONSIBLE-USE.md covers site terms of service, robots.txt, rate limits, no CAPTCHA or ban evasion, and read-only access to the user's own profile and cookies; the docs define "stealth" as exactly the two concrete choices (no --enable-automation, no Runtime.evaluate).
- [docs-marketing-run.8] (PA8.3) No README.md or docs/ prose (excluding the ported docs/reference/ protocol reference and generated .catalog data) contains the overclaim words undetectable, bypass, evade or anti-bot.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "entrypoint/stealth-browser/bin/"]
mutates:    ["entrypoint/stealth-browser/docs/", "entrypoint/stealth-browser/AGENTS.md", "entrypoint/stealth-browser/llms.txt", "entrypoint/stealth-browser/CHANGELOG.md", "entrypoint/stealth-browser/README.md"]
```

---

## Contract Promise

Added/Modified: docs, AGENTS.md, llms.txt, CHANGELOG.md, README.md under `entrypoint/stealth-browser/`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:docs-marketing-run]`:

- [ ] After the catalog and review PASS -- commit docs by explicit path: `docs(stealth-browser): marketing run [psm:docs-marketing-run]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The cartographer executes receipts: hb-chrome-binary applies in spirit; run on a dedicated port, never 9222.
