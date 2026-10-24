# doc-ops

## rewrite CHANGELOG.md — 2026-10-24
reason: missing 0.1.0 entry (docs-marketing-run.12).
removed_or_moved (verbatim):
```
## Unreleased

Initial scaffold of `@adhd/stealth-search`.
```

## rewrite AGENTS.md — 2026-10-24
reason: bring facts (operations, defaults, error codes, stdout rule) into the agent notes; keep the change rules.
removed_or_moved (verbatim):
```
# @adhd/stealth-search

Search entrypoint built on `@adhd/stealth-core-browser`: a CLI (`stealth-search`) and an MCP server (`stealth-search-mcp`) projected from one apigen API.

- Consumes the BUILT core package only; never reaches into the core `src/`.
- CJS-only (ADR-0003); relative imports use `.js` specifiers.
- Gates: `nx run stealth-search:lint`, `:typecheck`, `:build`, `:test`.
- Spec: `docs/plan/stealth-browser/SPEC-stealth-search.md`.
```
(all four rules are retained in the new file)

## create llms.txt, docs/CONFIGURATION.md, docs/EXAMPLES.md, docs/RESPONSIBLE-USE.md — 2026-10-24
reason: missing bundle documents (docs-marketing-run.12).

## revise docs/OBSERVABILITY.md — 2026-10-24
reason: lacked the sink enablement, --verbose/stderr diagnostics and the MCP stdout/JSON-RPC rule (docs-marketing-run.9).
removed_or_moved (verbatim):
```
## Where the records go

`--log-dir <path>` selects the directory of the telemetry files; the default is the sox-telemetry default.
```
(superseded by the new section)

## revise docs/ERRORS.md — 2026-10-24
reason: cartographer found the UNKNOWN_PROVIDER sample message wrong. Prior sample text: `provider "nope" is not registered — Use one of the registered provider ids ...`; replaced by the captured real output; added the MCP `{data: ...}` input wrapper note.

## revise README.md — 2026-10-24
reason: define "stealth" as the two concrete choices, state Google provisional, link the docs; no removals.

## gap: community-health files
CONTRIBUTING, SECURITY and CODE_OF_CONDUCT are not created for this package; LICENSE already exists and is linked.
