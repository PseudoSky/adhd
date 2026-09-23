# Backlog CLI — Demo

**Status: shipped.** This directory documents the backlog CLI's live surface, exercised
against the built binary (`entrypoint/backlog/dist/index.js`, bin name `adhd-backlog`).
Every command shown was run and its output captured; nothing here is aspirational.

## What this is

A demo-creator-format walkthrough of the backlog CLI: one flat command table (`get`,
`query`, `create`, `update`, `relate`, `claim`, `transition`, `move`, `delete`, `lookup`,
`rm-location`, `upsert-project`, `upsert-component`, `upsert-location`, `batch action`)
plus a few special commands (`serve`, `search`, `sandbox-path`, `install-skill`, and the
global `--sandbox` isolation flag), served identically across CLI, MCP, HTTP, and OpenAPI
via `apigen`. The demo doubles as an acceptance script: every step carries the exact
command, the exact JSON envelope returned, and maps to the acceptance criteria in
`entrypoint/backlog/SPEC.md` §8 (AC-1..AC-23) where a criterion applies.

## File map

| File | Purpose |
|---|---|
| `DEMO.md` | The persona-narrated walkthrough (start here) |
| `README.md` | This file |
| `UNRESOLVED.md` | Ledger of interface questions raised while authoring the demo, and how each resolved against the live binary |
| `fixtures/backlog-demo.md` | The canonical demo dataset, expressed as the real `create`/`upsert-*` calls that seed it (there is no bulk-import command) |

## How to run it

Prerequisites: the package built (`dist/index.js` present under `entrypoint/backlog/`).
This repo uses `pnpm`, not `yarn`/`npm`.

```bash
node entrypoint/backlog/dist/index.js --help
node entrypoint/backlog/dist/index.js --sandbox sandbox-path
```

`--sandbox` isolates every command that follows it into a fresh throwaway store instead
of the live production store (`~/.adhd/backlog/production`). Pass `ADHD_ROOT=<dir>` to
reuse the same sandbox store across calls instead of getting a fresh one each time. Never
invoke the CLI against the production store from this demo.

Then walk `DEMO.md` top to bottom. Every command in it was run under `--sandbox` with a
scratch `ADHD_ROOT` and its real output pasted in — a run is reproducible by copying the
commands verbatim.

## Status legend

Every step in `DEMO.md` is tagged with one of:

- **verified** — the exact command was run against the built binary and the JSON shown is
  its real output.
- **documented, not exercised** — the command exists in `--help` but this demo did not
  drive it end to end; flagged so a reader doesn't mistake it for a verified claim.

There is no other tier. A command that could not be verified by running it was removed
from this demo rather than left as a guess.
