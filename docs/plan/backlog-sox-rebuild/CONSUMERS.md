# Consumer inventory — every caller that breaks when the old layer is deleted

Survey performed before the deletion commit. Every row was verified by OPENING the
cited file, not by a ripgrep hit. Counts: **9 BREAKS, 11 SAFE (groups), 1 UNCERTAIN**.

The deletion removes the ~38-verb flag surface, the `migration-phase` machinery, and
the `humanId` identity model (identity becomes a DB-generated `uid`). External
callers are fixed in a SEPARATE COMMIT BEFORE the deletion — never inside it.

## BREAKS — must be fixed first, in priority order

| # | Location | Depends on | Failure mode | Fix |
|---|---|---|---|---|
| 1 | `~/.claude/skills/backlog/SKILL.md` (GLOBAL, lines 24-35, 97-200) | `migration_status`; `humanId` documented as the identity returned by get/update/query/create | Every agent on the machine, in every repo, is instructed to use a dead verb and a dead identity field | Rewrite for `uid`; drop the migration-phase section. **Outside this repo — needs an explicit decision.** |
| 2 | `docs/plan/backlog-adoption/parity-check.mjs:64,106-107` | `it.humanId` | Does NOT crash and always exits 0 — silently reports 100% divergence forever, so the CI parity signal becomes meaningless without failing | Key `toMap` on `uid` |
| 3 | `docs/plan/backlog-adoption/render-projections.mjs:95,116-117` | retired `list-items` + `render-to-markdown`, flag-style; keys on `humanId` | HARD CRASH — `execFileSync` throws on the retired verb's non-zero exit. This is the script that overwrites the live `BACKLOG.md` | Rewrite onto `query --input` + `uid` |
| 4 | `AGENTS.md:26` | `adhd-backlog admin --input '{"action":"migration_status"}'` documented as the authoritative phase check | Read by every agent in this repo | Delete the sentence with the machinery |
| 5 | `.claude/workflows/backlog-grooming.js:142-215` | `familyOf(humanId)`, dedupe key `${repo} ${humanId}`, sort by `.humanId` | Live recurring workflow that WRITES (set_priority/append_note) | Rekey all three on `uid` before its next run |
| 6 | `docs/plan/backlog-adoption/import-manifest.mjs:46-48` | `import-from-markdown` + the `humanId`/`idOverride` upsert key | Verb is deleted outright | Retire with the migration corpus — a one-time Phase-1 seed, already executed |
| 7 | `docs/plan/backlog-adoption/MIGRATION.md` | quotes the same dead commands | Stale as an actionable doc | Archive/rewrite |
| 8 | `.claude/workflows/backlog-adversarial-loop.js:65-71,166,227,248` | JSON schema requires `humanId` | Breaks on next re-run only (on-demand) | Update schema + prompt text |
| 9 | `.github/workflows/ci.yml:57-72` | transitively #2 | Non-fatal; stays green but meaningless | Falls out of fixing #2 |

## UNCERTAIN

`.mcp.json:16-20` mounts `node entrypoint/backlog/dist/index.js serve --transport mcp`.
The path is **relative**, so which `dist/` a live session loads depends on the cwd
Claude Code was launched from — not on which worktree anyone is editing. It could not
be determined from inside a session which physical directory the live mount is bound
to. Practical rule: a worktree-scoped build is safe for a session launched elsewhere,
but **every live session should reload `/mcp` on `backlog` after the deletion merges**
rather than assuming isolation.

## SAFE — verified by opening, not assumed

- `tools/nx-plugins/**` — every hit is a comment, an incident citation, or a synthetic
  fixture using `@adhd/backlog` as an opaque package name (`compute-real-deps.js:71-84`,
  `sync-global.spec.mjs`, `version/impl.spec.mjs:1085`, `generate-manifest.spec.mjs:275-284`,
  `run-release.mjs:39`, `clean-room-smoke*`).
- `tools/util/backlog.mjs` — an independent legacy `BACKLOG.md` text parser; zero
  references to `@adhd/backlog` or `entrypoint/backlog` anywhere in the file.
- All workspace `package.json` files — only `entrypoint/backlog`'s own. **Zero in-repo
  dependents**, which is why a backlog-only change affects exactly one nx project.
- `tsconfig.base.json:150` — a path alias; fine while `src/index.ts` exists.
- `.githooks/*` — the word "backlog" in prose only.
- `.claude/workflows/burn-wave-2.js`, `code-quality-sweep.mjs` — completed historical
  record / advisory prose that explicitly tells the agent to discover the real invocation.
- `packages/apigen/**` — comments and a hand-copied interface literal, never an import.

## The rule this inventory exists to enforce

Fix every BREAKS row in its own commit BEFORE the deletion commit. The deletion commit
contains nothing but deletions and the mechanical import fallout they force.
