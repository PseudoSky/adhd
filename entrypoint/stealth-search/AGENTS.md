# @adhd/stealth-search

Search entrypoint built on `@adhd/stealth-core-browser`: a CLI (`stealth-search`) and an MCP server (`stealth-search-mcp`) projected from one apigen API.

- Consumes the BUILT core package only; never reaches into the core `src/`.
- CJS-only (ADR-0003); relative imports use `.js` specifiers.
- Gates: `nx run stealth-search:lint`, `:typecheck`, `:build`, `:test`.
- Spec: `docs/plan/stealth-browser/SPEC-stealth-search.md`.
