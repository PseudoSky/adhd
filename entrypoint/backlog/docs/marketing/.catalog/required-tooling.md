# Required tooling — `entrypoint/backlog`

No hard blocker. The catalog was produced with store-free commands only, per the read-only constraint (`NEVER write to ~/.adhd/backlog/**`).

## Missing / needed for fuller verification
| Need | Use case | Capabilities left without runtime proof |
|------|----------|------------------------------------------|
| A disposable isolated store root outside `~/.adhd/backlog/**` | Run `create`/`transition`/`query`/`claim`/`relate`/`priority-matrix`/`part-of-rollup`/`open-curve` end-to-end without touching the live production graph. `--namespace sandbox` mints a throwaway root, but that root lives under `~/.adhd` — out of bounds for this task. | `create`, `update`, `transition`, `claim`, `relate`, `move`, `delete`, `query`, `priority-matrix`, `part-of-rollup`, `open-curve` (runtime proof only; all have source + spec + test receipts, and the three stats verbs are now confirmed **mounted** from `--help`) |
| `backlog-e2e-*` harness | The blind multi-agent real-world tests `CONTRIBUTING.md` describes are absent from the repo (its own status callout confirms it; `git log --all` has no history for those paths). | CLI/MCP/skill discoverability is unproven end-to-end. |
| Optional embedding backend (`@adhd/sox-embedding-provider` + `@adhd/sox-vector-store`) | Exercise semantic `filter.semantic`, `view:'similar'`, `sort:'relevance'`. | `query-views` (semantic members) — degrades to `rag_not_configured` when absent, as documented. |

## Available and used
- `node` (v24): ran `dist/index.js --help`, exit 0 — proves the 17 verbs + `batch action` + 5 special commands are mounted, including `priority-matrix`/`part-of-rollup`/`open-curve`.
- `rg`: source/receipt confirmation.
- No `sqlite3` used; store never opened.
