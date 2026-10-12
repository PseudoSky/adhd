# readme-rewrite — WORK STATE

**Phase:** docs · **Kind:** work · **Depends on:** docs-marketing-run · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py readme-rewrite`
**Executor:** `content-marketer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The README is rewritten to be exciting and honest: a sharp tagline, quickstart for library/CLI/MCP, features, surfaces, and receipts that resolve to shipped capabilities.

---

## Semantic Distillation

- **Primitive:** REWRITE `entrypoint/stealth-browser/README.md` (only).

- **Reference Pattern:** `entrypoint/stealth-browser/docs/marketing/.catalog/capabilities.json`, `entrypoint/stealth-browser/docs/marketing/` (evangelist copy if present), `entrypoint/stealth-browser/package.json` (bin names, exports).

- **Delta Spec:** Sections: title, one-line `>` tagline (<= 120 chars), Quickstart, Features, Surfaces (library/CLI/MCP), Receipts (`<!-- receipt:ID -->` markers, >= 5, each resolving to a `shipped` capability). No unverifiable superlatives (undetectable, unblockable, 100%, bypasses all, guaranteed). Import specifiers and bin names must exist.

- **Invariants:** Docs/README paths only ([inv:owned-paths-only]); no AI-attribution lines. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:readme-rewrite]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py readme-rewrite` — runs every acceptance criterion below (red until the work is done); `--only readme-rewrite.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py readme-rewrite --only readme-rewrite.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [readme-rewrite.1] Only README.md changed by [psm:readme-rewrite] commits.

- [readme-rewrite.2] README has a title, a tagline <= 120 chars, Quickstart, Features, Surfaces and Receipts sections and >= 2 fenced code blocks.
- [readme-rewrite.3] Receipts: >= 5 `<!-- receipt:ID -->` markers and every ID resolves to a `shipped` entry in docs/marketing/.catalog/capabilities.json.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/docs/", "entrypoint/stealth-browser/package.json"]
mutates:    ["entrypoint/stealth-browser/README.md"]
```

---

## Contract Promise

Modified: `entrypoint/stealth-browser/README.md`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:readme-rewrite]`:

- [ ] After the rewrite -- commit by explicit path: `docs(stealth-browser): exciting README [psm:readme-rewrite]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Excitement comes from concrete capability and receipts, not adjectives. Roadmap items must be labelled as such or omitted.
