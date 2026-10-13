# docs-marketing-run — WORK STATE

**Phase:** docs · **Kind:** work · **Depends on:** gates-rerun · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run`
**Executor:** `doc-steward` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

A doc-steward marketing run has made the package documentation correct and receipts-backed: capability catalog, reviewed PASS, AGENTS.md, llms.txt, CHANGELOG with the migration entry, and a README baseline.

---

## Semantic Distillation

- **Primitive:** RUN doc-steward on `packages/stealth/stealth-core-browser/` and on `entrypoint/stealth-search/`; WRITE `docs/**`, `AGENTS.md`, `llms.txt`, `CHANGELOG.md`, `README.md` under each.

- **Reference Pattern:** `packages/stealth/stealth-core-browser/docs/reference/**`, the built search bins, `docs/marketing/.catalog/` produced by the cartographer.

- **Delta Spec:** Dispatch `doc-steward` once per package: `packages/stealth/stealth-core-browser` (library: six verbs and namespaces) and `entrypoint/stealth-search` (the eleven `stealth_*` tools across CLI/MCP, host flags, observability, errors, examples; criterion docs-marketing-run.12 and its own `docs/marketing/.catalog`). Each dispatch runs the steward. It dispatches the cartographer (capabilities.json with a runnable receipt per shipped capability -- the six verbs across library/CLI/MCP), rewrites the doc surface, and gates on doc-reviewer PASS (`docs/marketing/.catalog/review.md`). CHANGELOG gets a `0.0.1` migration entry. The second approved package `@adhd/resilience-core-tripwire` is documented by `tripwire-docs` (README, CHANGELOG 0.1.0, docs/ERRORS.md, docs/RECOVERY.md); this state only verifies they exist and carry no AI attribution (docs-marketing-run.11) and never edits that package's `src/`. Documentation only: no `src/` or `bin/` change (guard checks that the gates-rerun tree is still the source tree). Productization docs (PRODUCT-REVIEW.md P6/P8/P9), each a file under `packages/stealth/stealth-core-browser/docs/` (OBSERVABILITY.md lives in `entrypoint/stealth-search/docs/`, which also carries its own CONFIGURATION, ERRORS, EXAMPLES and RESPONSIBLE-USE): `CONFIGURATION.md` (every default verbatim: port `9222`, profile `~/Library/Application Support/Google/Chrome-CDP`, the lifecycle state directory `<os.tmpdir()>/stealth-browser-<uid>-<port>` (the runtime artifact name is kept) (ownership record, breaker file, reaper socket) and the `stateDir` / `reaperScope` / `orphanWindowMs` options; the `--port`/`--user-data-dir` overrides; macOS-first support and which behaviours are untested elsewhere), `RESPONSIBLE-USE.md` (site terms of service and robots.txt, rate limits, no CAPTCHA or ban evasion, cookie and profile reads are read-only on the user's own profile), `OBSERVABILITY.md` (`adhd.<op>.start|finish|error` records, how to enable the sink, `--verbose` stderr diagnostics, the MCP bin writes only JSON-RPC to stdout). **No-overclaim brief for every doc this state writes (including anything doc-evangelist produces under docs/marketing/):** "stealth" means exactly two concrete choices, Chrome is launched without `--enable-automation` and pages are read without `Runtime.evaluate`; it does NOT mean undetectable. Never write the words undetectable, bypass, evade or anti-bot (README.md and docs/ outside the ported `docs/reference/` are scanned by `docs-marketing-run.8`); frame the value as an honest, lower-footprint way to work with the user's own logged-in browser.

- **Invariants:** Documentation only; no AI attribution lines in any doc; every claim has a shipped receipt. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:docs-marketing-run]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run` — runs every acceptance criterion below (red until the work is done); `--only docs-marketing-run.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py docs-marketing-run --only docs-marketing-run.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [docs-marketing-run.1] docs/marketing/.catalog/capabilities.json lists >= 6 `shipped` capabilities (the six verbs) each with a runnable receipt command; no entry lacks a status of shipped|roadmap|deprecated.
- [docs-marketing-run.2] docs/marketing/.catalog/review.md records a doc-reviewer verdict of PASS.
- [docs-marketing-run.3] AGENTS.md, llms.txt, CHANGELOG.md (with a 0.0.1 migration entry) and README.md exist; no AI attribution lines anywhere in them.
- [docs-marketing-run.4] Documentation-only: [psm:docs-marketing-run] commits touch only docs/, README.md, AGENTS.md, llms.txt, CHANGELOG.md (ownership).
- [docs-marketing-run.5] Gate evidence of gates-rerun still matches the package source trees (docs run changed no src/ or bin/ of stealth-core-browser, stealth-search or the tripwire package).
- [docs-marketing-run.6] (PA6.2, PA6.3) docs/CONFIGURATION.md lists every default verbatim (port 9222, the Library/Application Support/Google/Chrome-CDP profile, plus any state path the chrome-lifecycle design adds) and states macOS-first support with what is untested elsewhere.
- [docs-marketing-run.7] (PA8.1, PA8.2) docs/RESPONSIBLE-USE.md covers site terms of service, robots.txt, rate limits, no CAPTCHA or ban evasion, and read-only access to the user's own profile and cookies; the docs define "stealth" as exactly the two concrete choices (no --enable-automation, no Runtime.evaluate).
- [docs-marketing-run.8] (PA8.3) No README.md or docs/ prose (excluding the ported docs/reference/ protocol reference and generated .catalog data) contains the overclaim words undetectable, bypass, evade or anti-bot.
- [docs-marketing-run.9] (PA9.1) stealth-search docs/OBSERVABILITY.md documents adhd.<op>.start|finish|error records, how to enable the sink, the --verbose stderr diagnostics, and that the MCP bin writes only JSON-RPC to stdout.
- [docs-marketing-run.10] (user: runnable examples and genuine use cases) docs/EXAMPLES.md lists every examples/ file (six verbs, five namespaces, cli.md, mcp-config.json) with its scenario in one sentence and links docs/ERRORS.md.
- [docs-marketing-run.11] The tripwire package is part of the docs surface: README.md, CHANGELOG.md (with a 0.1.0 entry), docs/ERRORS.md and docs/RECOVERY.md of packages/resilience/resilience-core-tripwire exist (written by tripwire-docs), carry no AI attribution lines (Generated with, Co-Authored-By, written by an AI), and the docs run changed nothing under the package's src/.
- [docs-marketing-run.12] The stealth-search docs surface exists: README.md, CHANGELOG.md (with a 0.1.0 entry), AGENTS.md, llms.txt and docs/{OBSERVABILITY,ERRORS,CONFIGURATION,EXAMPLES,RESPONSIBLE-USE}.md of entrypoint/stealth-search, no AI attribution lines, and its docs/marketing/.catalog/capabilities.json lists the eleven projected tools as `shipped` with runnable receipts and a review.md verdict of PASS.

---

## Reservations

```text
read_only:  []
mutates:    ["packages/stealth/stealth-core-browser/docs/", "packages/stealth/stealth-core-browser/AGENTS.md", "packages/stealth/stealth-core-browser/llms.txt", "packages/stealth/stealth-core-browser/CHANGELOG.md", "packages/stealth/stealth-core-browser/README.md", "entrypoint/stealth-search/docs/", "entrypoint/stealth-search/AGENTS.md", "entrypoint/stealth-search/llms.txt", "entrypoint/stealth-search/CHANGELOG.md", "entrypoint/stealth-search/README.md"]
```

---

## Contract Promise

Added/Modified: docs, AGENTS.md, llms.txt, CHANGELOG.md, README.md under `packages/stealth/stealth-core-browser/` and `entrypoint/stealth-search/`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:docs-marketing-run]`:

- [ ] After the catalog and review PASS -- commit docs by explicit path: `docs(stealth-browser): marketing run [psm:docs-marketing-run]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Productization guards (`docs-marketing-run.6-.9`) are cheap file checks; satisfy them before the doc-reviewer round so the reviewer sees the final set. `docs/reference/` (ported CDP protocol reference, names like `setBypassCSP`) is exempt from the word scan; do not rewrite it to dodge the scan.
- The cartographer executes receipts: run on a dedicated port, never 9222; Chrome-dependent receipts that cannot run in the sandbox are recorded as unverified, not guessed.
