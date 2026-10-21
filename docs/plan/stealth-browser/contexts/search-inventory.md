# search-inventory — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-scaffold · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-inventory`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every feature and failsafe of the source repo's agent-search is a row with a verified `file:line`, a destination state and a pin placeholder, so each port batch cites rows instead of re-deriving what to port.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/evidence/search-failsafe-inventory.json` only. READ `/Users/nix/dev/ai/scratch/agent-browser/` (the source repo, read-only until `search-cutover`).

- **Reference Pattern:** `docs/plan/stealth-browser/evidence/failsafe-inventory.json` (schema: `schema`, `baseline_commit`, `row_count`, `rows[{id, feature, tags, source{file,line,anchor}, owner_state, pin}]`); `SPEC-stealth-search.md` section 3 (seed rows I-01..I-42).

- **Delta Spec:** (1) Start from the 42 seed rows of spec section 3 (ids `I-NN`; split a row into `I-NN.a`, `I-NN.b` when one source range holds several failsafes). For each row open the source line and set `source` {file relative to the source repo root, line integer, anchor = a short exact text from within 3 lines of that line}; correct the seed line numbers where they drifted. `baseline_commit` is the source repo HEAD sha. (2) Row fields: `id`, `feature`, `destination`, `owner_state`, `symbols` (exported names the row covers), `source`, `pin` {file under `src/test/`, test} or `pin: null` plus `reason` for rows owned by hosts/usecases/examples/cutover/docs states. (3) Assign `owner_state` from: `search-errors`, `search-port-providers` (I-10, I-22, I-23, I-31), `search-port-fetch` (I-09, I-27..I-30), `search-port-engine` (I-11, I-12, I-24..I-26), `search-port-guards` (I-19..I-21, I-15 state), `search-verbs` (I-02..I-08, I-13..I-18), `search-hosts` (I-33..I-39), `search-usecases` (I-40), `docs-marketing-run`/`readme-rewrite` (I-41), `search-cutover` (I-42), `core-seam` (I-01, I-08 manager side), `none` for documented deletions (I-26 duplicate capture). (4) Cover every exported function/class/const of the source files named in criterion .3 by listing it in some row's `symbols`; run a script (not by eye) that diffs the exports against the union and prints the gap.

- **Invariants:** [inv:source-untouched] [inv:greenfield] [inv:shared-worktree]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-inventory]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-inventory` — runs every acceptance criterion below (red until the work is done); `--only search-inventory.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-inventory --only search-inventory.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-inventory.1] evidence/search-failsafe-inventory.json (schema, baseline_commit, row_count, rows) holds one row for every seed row I-01..I-42 of the spec section 3 (ids `I-NN`; sub-rows `I-NN.a` allowed), `row_count` equals len(rows), each row has feature, destination, owner_state (one of the plan state ids that implements it, or `none` for a documented deletion) and `source` {file, line, anchor}.
- [search-inventory.2] Every row's `source.file` exists under /Users/nix/dev/ai/scratch/agent-browser (until the cutover) or is recorded with `source.baseline_blob`, its `line` is within the file, and the `anchor` text occurs within 3 lines of that line, so each citation is verified rather than copied.
- [search-inventory.3] The rows cover every exported function, class and const of the search source files (search-mcp-source, search-guard, search-tripwire, search-providers, search-types, search-network, search-dom, search-challenge, search-fetch, fetch-policy, fetch-markdown, fetch-pdf, network-capture, search/utils, search/queries/last-search, cdp-search): each exported name appears in some row's `symbols` list, and at least 10 of those files exist to be scanned.
- [search-inventory.4] Each row names the destination state it is implemented in and carries a `pin` {file, test} placeholder under entrypoint/stealth-search/src/test/ or `pin: null` with a `reason` for rows owned by hosts, usecases, examples, cutover or docs states; the 209 rows of evidence/failsafe-inventory.json are not duplicated (no row repeats a `fs-NNN` id).
- [search-inventory.5] Only owned paths changed by [psm:search-inventory] commits.

- [search-inventory.6] (backlog 406a4e66) The inventory records the Google SERP parsing as search-owned: at least one row whose feature, symbols or source mention the Google result-page (SERP) walker or `capture/dom.ts` has owner_state `search-port-engine` and a destination naming `dom.ts` (entrypoint/stealth-search/src/lib/dom.ts), so no Google SERP parser is left unaccounted for in the core.
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/evidence/search-failsafe-inventory.json"]
```

---

## Contract Promise

Added: `evidence/search-failsafe-inventory.json`. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-inventory]`:

- [ ] After the file validates against .1-.4: `docs(plan): search failsafe inventory [psm:search-inventory]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

## Backlog fold-in (2026-10-14 search bugs)

Backlog-facing: each criterion below is cited by a unit test simulating the real use case; ids are stable (appended, never renumbered).

- 406a4e66 -> [search-inventory.6]: a row records the Google SERP walker (`capture/dom.ts`) with owner `search-port-engine` and destination `dom.ts`.
