# DEMO — apigen transport-neutral serve-core + thin adapters

Acceptance walkthrough proving `FEAT-APIGEN-SERVE-CORE-000` end-to-end. Every step
drives a REAL consumer seam (never plugin internals) and has a binary PASS/FAIL.
Run from the repo root. The canonical, always-run form of this demo is the set of
committed parity specs it points at — this file is the human-narratable index over
them, and `audit_apigen-serve-core.py --phase final` is its machine gate.

> Persona: **Dana**, an apigen consumer + plugin author. Dana never edits source to
> make a check pass; Dana drives the shipped seam and reads the exit code.

## 0. Preconditions

```bash
corepack yarn install     # only in a fresh worktree (BUG-REPO-PRECOMMIT-DEPCHECK…)
```

PASS when `./node_modules/.bin/nx --version` prints a version.

## 1. The serve-core authority exists (dod.1, dod.7)

```bash
CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test
grep -E "createPackageInvoker|dispatchForPlan|OpPlan|TransportAdapter" \
  packages/apigen/apigen-engine-runtime/src/index.ts
```

PASS when the suite exits 0 and all four symbols are exported. The four per-plugin
shims are gone — proven in steps 2–5 by the `absent` criteria.

## 2. Every TS transport is byte-identical through its real seam (dod.2, dod.6, dod.9)

```bash
CI=true ./node_modules/.bin/nx run-many -t test \
  -p apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-mcp,apigen-plugin-cli-output
```

PASS when all four parity specs pass. Each: captured the CURRENT live server/CLI to
a committed golden snapshot, then re-drove the migrated adapter (fetch / MCP sdk /
spawned child) and asserted deep-equality — including the express void-return case
(`undefined→null`, dod.6) and the front-proxy / GET-hoist out-of-scope pins (dod.9).

## 3. MCP now validates (dod.4)

```bash
CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test
```

PASS when a real `@modelcontextprotocol/sdk` client sending schema-violating tool
input receives `invalid_argument` (previously: silently reached the domain fn).

## 4. Streaming is wired, not mis-serialized (dod.5)

Covered by the fastify/mcp/cli streaming fixtures in step 2/3: a `streaming:true` op
yields SSE frames (fastify), progressive content (mcp), and an explicit rejection
(cli/py). PASS = those fixtures pass.

## 5. Negative control — the gates have teeth (dod.3)

```bash
python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final
```

PASS when every adapter's negative-control criterion shows the `neg-control/<slug>.patch`
regression turning its parity suite RED, then GREEN on restore.

## 6. Python serves from the TS-computed plan (dod.8)

```bash
CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-py-flask,apigen-plugin-py-grpc
grep -c "_route_for_op\|_http_verb\|_is_primitive_only_input_schema" \
  packages/apigen/python/apigen_python/flask_server.py    # expect 0
```

PASS when both parity specs pass against real spawned Python servers AND the grep
count is 0 (the re-derivation port is deleted).

## 7. No regressions (dod.10)

```bash
python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final
```

PASS when the script exits 0 — every `[dod.N] PASS`, and `verify-dist-load` green for
`apigen-engine-runtime` + the four TS plugins (a consumer loads the shipped dist).

## Traceability

| Step | DoD | Real seam |
|---|---|---|
| 1 | dod.1, dod.7 | runtime unit suite + index exports |
| 2 | dod.2, dod.6, dod.9 | fetch / MCP sdk / spawned CLI child |
| 3 | dod.4 | @modelcontextprotocol/sdk client |
| 4 | dod.5 | streaming fixtures over each transport |
| 5 | dod.3 | neg-control patches (RED→GREEN) |
| 6 | dod.8 | spawned Python HTTP + gRPC servers |
| 7 | dod.10 | verify-dist-load + full [dod.N] gate |
