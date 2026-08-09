# Backlog Interface v2 — Target-State Demo

**Status: TARGET-STATE.** Nothing in this demo is implemented yet — the interface-v2
implementation is underway in parallel (work order C-13; plan `backlog-interface-v2-dispatch`).
This directory documents the *intended* 6-tool experience so an implementer knows what
"done" looks like and a QA runner can verify it the day it ships.

## What this is

A demo-creator-format walkthrough of the backlog CLI's redesigned surface: **38 flat
commands collapse to 6 verbs** (`get`, `query`, `create`, `update`, `relate`, `admin`)
served identically across CLI, MCP, REST, and OpenAPI. The demo doubles as the acceptance
script: every step carries exact commands, exact expected JSON envelopes, exit codes, and
binary pass/fail assertions, and maps to the acceptance criteria table (AC-0..AC-31) in
`docs/spec/backlog/INTERFACE_v2.md` §10.

## File map

| File | Purpose |
|---|---|
| `DEMO.md` | The persona-narrated walkthrough + acceptance contract (start here) |
| `README.md` | This file |
| `UNRESOLVED.md` | Ledger of every interface this demo had to guess (⟦U1⟧..⟦U13⟧) — the "confirm these first" list for the implementer |
| `fixtures/backlog-demo.md` | The canonical demo dataset as an import fixture |

## How to run it

Prerequisites and the exact cold-start sequence are in `DEMO.md` §2.3–2.4. In short:

```bash
corepack yarn install
npx nx build backlog
npx nx run backlog:verify-dist-load
backlog serve --transport http --port 8787 &
```

Then walk `DEMO.md` top to bottom. A run is **PASS** only if every ✅ checkbox is ticked
and every AC in §7 is proven — one unchecked binary assertion = FAIL.

## Status legend

Every step in `DEMO.md` is tagged with one of:

- **target-state (gates AC-NN)** — the capability is not shipped yet; this step is the
  intended experience, gated on the named ACs. This is the default for almost every step.
- **shipped today (v1 …)** — describes the current v1 behavior (e.g. `backlog list-items`
  and the 38-command flat surface, `backlog serve --transport mcp`, `import-from-markdown`).
  These exist so the demo can contrast the old surface with the new one — most notably in
  the §1.2 negative control.

## Source of truth

This demo is derived **only** from these documents — it does not re-derive or redesign
anything:

- `docs/spec/backlog/INTERFACE_v2.md` — the six verbs (§1–§6), cross-cutting contracts (§7),
  acceptance criteria AC-0..AC-31 (§10)
- `docs/spec/backlog/GRAPH_MODEL_v2.md` — dimensional model, canonical repo/identity
  resolution, migration
- `docs/spec/backlog/PLUGIN_ARCHITECTURE.md` — embedding-remote plugin, health, sox
  embedding bundle
- `entrypoint/backlog/RAG-SPEC.md` — semanticSearch, embed pipeline, plan-graph ops,
  dedup, cluster, backfill

## Known caveats

- **Memory (BUG-MEMORY-013):** a memory recall for prior demo/backlog art was attempted
  once and returned no data; this demo proceeds from the four specs above.
- **Spec ambiguities** are logged in `UNRESOLVED.md`, not resolved here (see also the
  "Spec ambiguities" section of the C-13 report).
