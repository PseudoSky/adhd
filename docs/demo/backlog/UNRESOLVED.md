# Resolved interfaces — Backlog CLI demo

This demo previously guessed at a set of interfaces before the surface shipped. Each guess
is recorded below with what the shipped binary actually does, verified by running it.
Items whose underlying capability does not exist in the shipped surface are marked as such
rather than carried forward as open questions.

| ID | What was guessed | What shipped | Basis |
|---|---|---|---|
| U1 | A dedicated project-level cross-repo traversal view/flag | `query({filter:{project}})` narrows a listing to one project; there is no separate cross-repo traversal flag in the shipped `query` input | `entrypoint/backlog/SPEC.md` §6.5 rule 3 |
| U2 | A CLI exit-code table covering every error code | Confirmed by running the binary: a well-formed call that fails at the domain level (e.g. `get` on an unknown `uid`) returns `{"ok":false,"error":{...}}` on **exit 0** — the failure is carried in the envelope, not the process exit code. A malformed invocation (bad flags/JSON) exits non-zero with a plain-text `apigen`-shaped error, not a JSON envelope. | verified against `entrypoint/backlog/dist/index.js` |
| U3 | Exact `--help` layout | Confirmed: `node dist/index.js --help` prints the special-commands block (`install-skill`, `serve`, `search`, `sandbox-path`, `--sandbox`) followed by the flat `Available commands:` table, one line per verb with its input shape | verified directly |
| U4 | `GET /` body shape when served over HTTP | Not exercised in this demo — `serve --transport http` was not driven end to end here. Documented in `README.md`'s status legend as "documented, not exercised," not asserted. | — |
| U5 | OpenAPI path spellings | Not exercised in this demo for the same reason as U4 | — |
| U6 | A `view:summary` JSON shape with specific field names | No `view:summary` exists in the shipped `query` input's `view` enum as exercised here; dropped rather than guessed | verified against `--help` output for `query` |
| U7 | Parent/root inclusion in a `view:ready` predicate | Same disposition as U6 — not present in the surface exercised here | verified against `--help` output for `query` |
| U8 | CLI create flag spellings (`--title`, `--kind`, …) | The shipped CLI does not take per-field flags at all: every verb takes exactly one `--input '<json>'` argument matching its typed input shape (confirmed for `create`, `get`, `upsert-project`, `upsert-component`, `transition`, `claim`, `query`, `delete`, `lookup`) | verified directly, see `DEMO.md` |
| U9 | A `--weight-fn` CLI flag | No `weightFn`/`view:plan` surface is present in the shipped `query` input as exercised here; dropped | verified against `--help` output for `query` |
| U10 | `get` on a soft-deleted item: card vs. error code | Confirmed: `get` after `delete` on the same `uid` still resolves the card (soft delete is bi-temporal, never a hard delete or a not-found) | `entrypoint/backlog/SPEC.md` §8 AC-18; behavior verified directly |
| U12 | A bulk file-import command and its file-format grammar | No import/bulk-load command exists in the shipped surface (no `admin` verb, no `import` action). The fixture dataset is now expressed as the real `create`/`upsert-*` calls that reproduce it — see `fixtures/backlog-demo.md`. | verified against `--help`: no import-shaped command is listed |
| U13 | A `--store <path>` CLI flag for isolating the demo's writes | Superseded by the shipped `--sandbox` global flag plus `ADHD_ROOT` env var, which isolates a run into a throwaway store without any per-command store flag | verified directly, see `README.md` |
| U14 | A `semanticWeight` control knob | Not exercised in this demo; `query`'s `text` input performs a fused search per `entrypoint/backlog/SPEC.md` §8 item 7, but no explicit weight parameter was found on the shipped `query` input as exercised here | verified against `--help` output for `query` |

## Scope gaps

- **HTTP/MCP/OpenAPI transports** (U4, U5) are described by `entrypoint/backlog/SPEC.md`
  §6.7 but were not driven end to end in this demo; `serve` is listed in `--help` but its
  routes were not independently verified here. Do not treat any route shape in this
  directory as confirmed until a follow-up pass exercises `serve` directly.
- No other scope gaps: every command documented in `DEMO.md` was run against the built
  binary and its real output captured.
