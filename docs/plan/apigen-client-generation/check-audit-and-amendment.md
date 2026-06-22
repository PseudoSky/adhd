<!-- markdownlint-disable MD013 MD033 -->
# Check-Verification Audit & Amendment Proposal — apigen-client-generation

> **Scope:** Repair an authored `plan-state-machine` plan that fails its own preflight gates. This document is **propose-only** — no edits applied to `dag.json` / `state.json`. Caller sign-off required before stamping (see F2 and Open Questions).
> **Author:** api-designer (review pass)
> **Date:** 2026-06-21
> **Verification standard applied:** repo `CLAUDE.md` §6 ("Proving features actually work").

---

## 0. ⚠ ORCHESTRATOR-VERIFIED CORRECTIONS (read before applying F1 & F6)

The orchestrator validated this proposal against the actual 0.8.15 gate source (`gap-check.js:931-942`, `lib/env-pin.js`). **F1 and F6 as written below would trigger a SECOND red preflight.** Apply these corrections — they supersede the corresponding text in §3:

**F6 (interfaces.json) — supersedes §3 "F6":**
1. `gap-check.js:931` requires ALL FOUR fields non-empty: `interface`, `shape`, `provenance`, `confidence`. Do **NOT** rename `shape`→`interface` (leaves `shape` empty → new FAIL). **ADD** a new `interface` field (a concise one-line signature/contract) **AND KEEP** the detailed `shape` object. Both populated.
2. Do **NOT** change `provenance`. `PROV = ["vendored-source","docs","spike","assumed"]` — `vendored-source` is VALID; changing to `vendored` CREATES a failure. Leave it `vendored-source`.
3. `confidence: "high"` → `"vendored"` is correct (`CONF = ["verified","vendored","documented","assumed"]`). Keep.
4. All **7** entries fail (earlier output was tail-truncated; ts-morph + ts-json-schema-generator fail identically). Apply to all 7.
5. No state currently cites any interface (`grep -rE "\[iface:[a-z0-9-]+\]" contexts/ dag.json` is empty → gap-check WARN). Add `[iface:<slug>]` citation tokens to the relevant contexts (plugin-mcp→`[iface:mcp-sdk]`, nx-generator→`[iface:nx-devkit]`, cli-*→`[iface:commander]`, schema-extraction→`[iface:ts-morph]`+`[iface:ts-json-schema-generator]`, plugin-api-fastify→`[iface:fastify]`, plugin-api-express→`[iface:express]`).

**F1 (env-pin) — supersedes §3 "F1":**
The `# guard-less-gate:` sentinel **does not exist** in 0.8.15. `lib/env-pin.js` recognizes pinning ONLY via: `./node_modules/.bin/…`, `npx --yes`/`-y`, a `python3 …​.py` script invocation, or a declared `PLAN_ENV_LABEL`. For all 4 unpinned guards (scaffold-packages, scaffold-plugins, plugin-fastify-checkpoint, done): RECOMMENDED — route each through the already-pinned python audit by adding phases, e.g. guard → `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase scaffold-packages` (pinned via the `.py` rule + consolidates the check). Acceptable alternative — wrap in `npx --yes -p node -- node -e "…"`.

**F4 confirmed correct:** gate regex is `/^##\s+Value delta\s*$/m` — literal `## Value delta` (space, not hyphen). The §3 F4 rename is right.

---

## 1. Executive verdict

**Can green coexist with a broken product? YES — today, trivially.**

Every behavioral DoD clause (`dod.1`, `dod.2`, `dod.5`, plus `dod.3`, `dod.4` partially) is gated by an audit check that runs `npx nx test apigen-cli --testPathPattern=integration/<x>` and **trusts only the runner's exit code** (`audit_apigen.py:529-564`). The audit script never asserts the declared observable itself — it delegates entirely to integration spec files that **do not yet exist** (greenfield; `state.json.current_state == "scaffold-packages"`, all states `pending`). The assertions live in `contexts/integration-tests.md` prose, not in any enforced check. So the guarantee "`callTool('getUser',{data:{userId:'abc'}})` returns `{id:'abc',name:'Alice',role:'user'}`" is enforced **only as strongly as whatever test the implementer happens to write**. A test that does `expect(true).toBe(true)` in `integration/mcp.spec.ts` makes `dod.1` go green while the product is broken. There is no negative-control, no teeth requirement, no assertion-of-value encoded in the gate.

Compounding this: the `test -f <fixture> && nx test …` pattern (`audit_apigen.py:532,540,563`) is the exact `… | grep -q passed`-class anti-pattern §6.4 warns against in spirit — the `test -f` half is pure file-existence theater (the README author even admits this in the comment: *"`test -f` anchors to the exact fixture path … so gap-check sees the token"*), and the `nx test` half can pass with a vacuous spec.

**Conclusion:** If every check were green today, the product would **NOT** be proven to work. The plan also cannot even *start* — it fails 6 of the 0.8.15 skill preflight gates (F1, F3, F4, F5, F6, F8; F2 is an un-stamped-DoD warning). Part B fixes all of them. The single highest-leverage fix is **F3**: move the observable assertions out of context prose and into the audit script as value-asserting checks with negative controls, so green *cannot* be achieved while the behavior is broken.

---

## 2. PART A — Check-verification audit

### 2.1 Method

I read every gating check: the 8 DoD clauses (`README.md:65-94`), every criterion in `audit_apigen.py` across all 6 phases (`audit_apigen.py:137-639`), and each state's `guard` in `dag.json`. Classification per the standard: **REAL** = drives the real entrypoint AND asserts the declared observable, fails when behavior regresses. **PROXY** = build/test "passes", file exists, grep matches, runs an entrypoint without asserting the result, or asserts implementation shape instead of outcome.

### 2.2 DoD clauses (README.md:65-94)

| check-id | clause | what it runs | REAL/PROXY | gap | required fix |
|---|---|---|---|---|---|
| `dod.1` | MCP run e2e | `audit_apigen.py:529` `test -f real-api.ts && nx test …integration/mcp` | **PROXY** | `test -f` is file-existence; `nx test` asserts nothing the script controls — the tool/list names + `getUser` JSON observable live in spec prose only. Green with a vacuous spec. | F3: replace with a value-asserting check that spawns the CLI via the SDK client and greps the actual `tools/list`+`callTool` JSON; add negative-control. |
| `dod.2` | generate parity | `audit_apigen.py:537` `test -f … && nx test …integration/parity` | **PROXY** | Same — delegates to a not-yet-written parity spec; no assertion that generated `server.ts` output equals run-mode output. | F3: assert byte/JSON equality of `callTool('getUser')` from generated server vs in-process run, driven by the script. |
| `dod.3` | ctx excluded `[structural]` | `audit_apigen.py:544` `nx test …integration/schema` | **PROXY (mitigated)** | Behavioral truth ("`ctx` absent from every params") sits in spec prose. "structural" label is *acceptable* IF the schema spec asserts `ctx` absence with teeth — but the gate doesn't enforce that. Also redundantly covered by `audit-core.9` grep (which is itself proxy — see below). | F3: add `delivered-by` + `negative-control` (inject `ctx` into a fixture, schema must show it absent). Keep `[structural]` only if the spec assertion is named + teeth-proven. |
| `dod.4` | session override `[structural]` | `audit_apigen.py:551` `nx test …integration/schema` | **PROXY** | Same delegation; `getUser.input.required` contains `session` and `ping` lacks it is prose-only. | F3: assert the two composed-schema shapes (`_shared.md:152-183`) directly; negative-control removes the override and expects `session` to reappear. |
| `dod.5` | run-registry tag filter | `audit_apigen.py:560` `test -f index.ts && nx test …integration/registry` | **PROXY** | The observable (tools `hello`+`world` present, `internal` absent, `hello`→`'a'`) is prose-only. | F3: script greps the live `tools/list` for `hello`/`world`, asserts `internal` **absent**, asserts `callTool('hello')==='a'`; negative-control un-tags `pkg-c` and expects `internal` to appear. |
| `dod.6` | 9 packages build `[structural]` | `audit_apigen.py:567` `nx run-many --target=build …` | **REAL (acceptable as structural)** | Build success IS the declared observable for this clause. Exit-code gated. Legitimate structural check. | None (already exit-driven). |
| `dod.7` | nx cache-aware | `audit_apigen.py:574` `nx run apigen-cli:generate-api` | **PROXY** | Runs the target once; asserts neither "files appear in outDir" nor "second run prints `local cache` + identical files". A target that errors-but-exits-0, or has no caching, passes. | F3: run twice; assert outDir non-empty after run 1; assert run-2 stdout contains `local cache` (or `read the output from the cache`) and the file set is byte-identical; exit 0. |
| `dod.8` | nx generator scaffolds `[structural]` | `audit_apigen.py:581` `nx g …:plugin test-plugin … && nx build apigen-plugin-test-plugin` | **REAL** | Drives the real generator AND the real build of the scaffolded package; exit-driven. The build half gives it teeth (boilerplate must actually implement `OutputPlugin`). | Minor: add cleanup of `packages/apigen/plugins/test-plugin` so re-runs are deterministic; otherwise acceptable. |

### 2.3 audit_apigen.py criteria by phase

| check-id | phase | what it runs | REAL/PROXY | gap |
|---|---|---|---|---|
| `audit-core.1` | foundation | `nx build apigen-core` (`:141`) | PROXY | Build ≠ behavior. Stands in for "schemas extract correctly". |
| `audit-core.3` (×8) | foundation | substring-in-`index.ts` for each export (`:145-160`) | PROXY | Asserts a symbol *string is present in a file* — not that it's exported, typed, or callable. `// generateSchemas` in a comment passes. |
| `audit-core.5` | foundation | `nx test apigen-core` (`:165`) | PROXY (delegates) | Runs the unit suite; observable correctness depends on spec content the gate doesn't control. |
| `audit-core.7/.8` | foundation | `grep_absent @adhd/apigen-runtime / -plugin` (`:167-179`) | PROXY (legit guard) | Architectural-isolation grep — acceptable as a *negative invariant* guard, but proves nothing about behavior. |
| `audit-core.9` | foundation | `grep_absent getType\|TypeChecker` (`:181`) | **PROXY (unsafe)** | Asserts implementation shape ("no TypeChecker call") as a proxy for `[inv:ctx-name-only]`. The real observable — `ctx` absent from schema — is `dod.3`. This grep can pass while `ctx` is wrongly *included* by name-bug. |
| `nx-generator.1/.4/.5/.6/.7` | foundation | all five run the **same** `nx test apigen-nx --testPathPattern=generator/executor` (`:193-220`) | PROXY | Five distinct criteria collapse to one undifferentiated test run. No per-behavior assertion (hasRun stub, tsconfig update) is independently gated. |
| `nx-generator.9` | foundation | `nx build apigen-nx` (`:191`) | PROXY | Build only. |
| `audit-runtime.1/.4` | runtime | `nx build` / `nx test apigen-runtime` (`:232-234`) | PROXY | Build + delegated test. |
| `audit-runtime.2` (×8) | runtime | substring-in-`index.ts` (`:236-250`) | PROXY | Same as audit-core.3 — string presence. |
| `audit-runtime.7/.8` | runtime | `grep_absent` plugin import / node built-ins (`:254-265`) | PROXY (legit guard) | Isolation/purity guards. Note `.8` regex `from 'fs'` misses `from "fs"` and `from 'node:fs'` — weak. |
| `audit-runtime.9` | runtime | grep for duplicated `dataParamNames`/`needsEnvelopeField` (`:268`) | PROXY (legit guard) | Single-path invariant via grep. Fine as a guard; not behavioral. |
| `scaffold-plugins.1` (×5) | plugins | `project.json` exists (`:293-299`) | PROXY | File existence. |
| `scaffold-plugins.2` | plugins | `nx show projects \| grep -c apigen-plugin` (`:300`) | **PROXY (unsafe)** | `grep -c` exit code is ignored; the count value is never asserted ==5. Passes with 0 if `check()` only keys on exit 0 — and `grep -c` exits 0 even printing `0`. |
| `scaffold-plugins.3` | plugins | `node -e` checks tsconfig paths (`:305`) | REAL (structural) | Actually throws if a path is missing. Exit-driven. Acceptable. |
| `scaffold-plugins.4` (×5) | plugins | `"run(" in plugin.ts` substring (`:311-322`) | PROXY | String match for `run(`; a commented `// run(` passes; doesn't prove a working run stub. |
| `scaffold-plugins.5` | plugins | `nx run-many build` 5 stubs (`:323`) | PROXY | Build only. |
| `plugin-fastify-checkpoint.1` | plugins | `test -f checkpoints/fastify-approved.md` (`:330`) | PROXY (legit human gate) | File-existence IS the correct mechanism for a human sign-off gate. Acceptable. |
| `audit-plugins.1/.2` | plugins | `nx run-many build/test` all plugins (`:347-350`) | PROXY | Build + delegated test. |
| `audit-plugins.4/.5/.6` | plugins | grep for inline dispatch / `--output` (`:352-375`) | PROXY (legit guard) | Invariant guards. |
| `audit-cli.1-.4` | cli | `nx build/test apigen-cli`/`apigen-nx` (`:387-393`) | PROXY | Build + delegated test. |
| `audit-cli.5/.7` | cli | `grep_absent '--output'` / `project.json` (`:396-423`) | PROXY (legit guard) | Invariant guards. |
| `audit-cli.6/.10` (×4) | cli | substring `registerXCommand` in index.ts (`:404-455`) | PROXY | String presence. |
| `audit-cli.8` | cli | `node -e` schema.required includes name (`:426`) | REAL (structural) | Throws on miss. Acceptable. |
| `audit-cli.9` (×2) | cli | `generators.json`/`executors.json` exist (`:433-442`) | PROXY | File existence. |
| `integration-tests.1-.14` | integration | each = `nx test … --testPathPattern=integration/<x>` (`:472-507`) | PROXY (delegates) | All 7 enforced checks delegate to spec files; the gate asserts nothing itself. Only 7 of the 14 advertised IDs are actually run (`.1 .3 .5 .8 .10 .12 .14`); `.2 .4 .6 .7 .9 .11 .13` are registered in the docstring (`:62-66`) but **never executed** — coverage holes hiding behind ID inflation. |
| `audit-final.inv-*` (5) | final | grep guards + `project.json` tag parse (`:587-637`) | PROXY (legit guard) | Invariant guards. The tag-parse one (`:620`) is REAL-structural. |

### 2.4 Per-state `dag.json` guards not covered by an audit criterion

| state | guard (`dag.json`) | REAL/PROXY | gap |
|---|---|---|---|
| `scaffold-packages` | `node -e` project.json exists (`:19`) | PROXY | File existence; **also F1: bare `node`, no pinned-tool marker.** |
| `core-types` | `nx build apigen-core` (`:49`) | PROXY | Build only. |
| `schema-extraction` | `nx test … generate-schemas.spec.ts` (`:65`) | PROXY (delegates) | Spec content uncontrolled. |
| `schema-composition` | `nx test … compose-schemas.spec.ts` (`:89`) | PROXY (delegates) | Same. |
| `runtime-middleware` / `runtime-dispatch` | `nx test …` (`:115,:135`) | PROXY (delegates) | Same. |
| `scaffold-plugins` | `node -e` 5 dirs exist (`:161`) | PROXY | File existence; **F1: bare `node`.** |
| `plugin-fastify-checkpoint` | `test -f fastify-approved.md` (`:202`) | PROXY (legit gate) | **F1: bare `test`, no guard-less-gate marker.** |
| each `plugin-*` | `nx test apigen-plugin-*` (`:214…`) | PROXY (delegates) | Spec content uncontrolled. |
| `done` | `node -e "process.exit(0)"` (`:419`) | PROXY (legit terminal) | **F1: bare `node`, needs guard-less-gate marker.** |

### 2.5 Coverage holes — desired end-state behavior with NO real check

1. **No value-asserting check anywhere proves the headline observable** (`callTool('getUser',{data:{userId:'abc'}})` → `{id:'abc',name:'Alice',role:'user'}`). It exists only as prose in `README.md:69` and `contexts/integration-tests.md`. Every gate that "covers" it (`dod.1`, `integration-tests.5`) delegates to an unwritten spec. **This is the central hole.**
2. **`--type mcp --transport sse|streaming-http` is never exercised.** `dag.json` `plugin-mcp.changes.adds_set_members` declares `stdio,sse,streaming-http` (`:243`) and `_shared.md:201` documents all three, but only `integration/http.spec.ts` (Fastify/Express) and `integration/mcp.spec.ts` (stdio) are run. SSE / streamable-HTTP MCP transports have **zero** coverage.
3. **CLI-output plugin (`plugin-cli-output`) generated code is never executed.** Plan says it emits a Commander program (`dag.json:281-293`) but no integration check runs the generated `cli.ts` and asserts a subcommand invocation produces correct output. `[dod]` has no CLI-output clause at all.
4. **`dod.7` cache-awareness is asymptotically unproven** — running an nx target once proves nothing about caching (the *distinguishing* feature in the clause).
5. **7 advertised `integration-tests.*` IDs (`.2 .4 .6 .7 .9 .11 .13`) are never executed** — registered in the docstring but absent from `phase_integration()`. `dispatch` round-trip, parity for `callTool` (not just tools/list), and per-export-mode assertions are weaker than the ID list implies.
6. **No live-model end-to-end test** (§6.5). MCP is an LLM-facing protocol; a scripted SDK client can fake a `tools/list` shape the real surface can't serve. No `AGENT_MCP_LIVE`-style gated check exists.

---

## 3. PART B — Amendment proposal (ready to apply on approval)

### F1 — env-pin: pin tool resolution in 4 guards

**Target:** `dag.json`. Four guards resolve `node`/`test` off ambient PATH and fail `env-pin-check --strict` (exit 4). Fix: for work/scaffold states use `npx --yes`-pinned invocation; for the human checkpoint and terminal use the skill's guard-less-gate marker comment (these are not tool-resolving gates and should be declared as such).

| state | before (`dag.json`) | after |
|---|---|---|
| `scaffold-packages` (`:19`) | `"guard": "node -e \"…project.json…\""` | `"guard": "npx --yes -p node -- node -e \"…project.json…\""` *(or, simpler and consistent with repo: invoke via the pinned tsx/node already used elsewhere — see note)* |
| `scaffold-plugins` (`:161`) | `"guard": "node -e \"…plugin.ts…\""` | `"guard": "npx --yes -p node -- node -e \"…plugin.ts…\""` |
| `plugin-fastify-checkpoint` (`:202`) | `"guard": "test -f …/fastify-approved.md"` | Add marker so the skill treats it as a human gate, not a tool gate: prefix guard with the skill's guard-less-gate sentinel, e.g. `"guard": "# guard-less-gate: human-approval\ntest -f docs/plan/apigen-client-generation/checkpoints/fastify-approved.md"` |
| `done` (`:419`) | `"guard": "node -e \"process.exit(0)\""` | `"guard": "# guard-less-gate: terminal\nnode -e \"process.exit(0)\""` |

> **Note for caller:** the cleanest pin depends on what `env-pin-check.js` accepts as a "pinned marker." Two candidates: (a) `npx --yes …` prefix (already the convention for every `nx`/`tsx` guard in this dag), or (b) the explicit `# guard-less-gate:` sentinel for non-tool gates. I recommend `npx --yes`-pin for the two `node -e` *work* guards (scaffold-packages, scaffold-plugins) and the `guard-less-gate` sentinel for checkpoint + done. **Confirm which marker form `env-pin-check.js` recognizes before applying** (Open Question 3).

### F3 — proxy DoD: rewrite behavioral clauses to assert observables + add `negative-control` / `delivered-by`

**Targets:** `README.md` (clause metadata) **and** `audit_apigen.py` (the enforcing checks). The clause text gains two new fields; the audit check is rewritten from a delegating `nx test` into a value-asserting command.

#### README.md — add `delivered-by:` and `negative-control:` to dod.1–dod.5, dod.7

Example, `dod.1` (`README.md:67-69`):

```diff
 - `[dod.1]` A user runs the CLI with a TypeScript source file and gets a working MCP stdio server …
   - entrypoint: npx tsx packages/apigen/cli/src/index.ts run --source …/real-api.ts --type mcp
   - observable: MCP tools/list returns createUser,getUser,listUsers,ping,sendEmail; callTool('getUser',{data:{userId:'abc'}}) returns {id:'abc',name:'Alice',role:'user'}; exit 0 on transport close.
+  - delivered-by: cli-run-cmd, plugin-mcp, runtime-dispatch, schema-extraction, integration-tests
+  - negative-control: rename fixture export getUser→getUserX; check [dod.1] MUST go red (tools/list no longer contains getUser).
```

Apply the same two-field addition to `dod.2` (delivered-by: cli-generate-cmd, plugin-mcp, integration-tests; negative-control: corrupt the generated `server.ts` template so a tool is dropped → parity check red), `dod.3` (delivered-by: schema-extraction, integration-tests; negative-control: remove the `getName()==='ctx'` guard → `ctx` appears in params → red), `dod.4` (delivered-by: schema-composition, runtime-middleware, integration-tests; negative-control: ignore the `false` override → `session` reappears in `ping` → red), `dod.5` (delivered-by: cli-run-cmd, registry discovery in cli-generate-cmd, integration-tests; negative-control: drop the `internal` tag filter → `internal` tool appears → red), `dod.7` (delivered-by: nx-generator, cli-generate-cmd; negative-control: disable target caching → run-2 omits `local cache` → red).

#### audit_apigen.py — rewrite enforcing checks (new/changed check bodies)

These convert delegation-to-`nx test` into script-controlled value assertions. They are written to be run from `REPO_ROOT` via the existing `run()` helper.

**`dod.1` (replace `:529-533`)** — drive the real CLI through the SDK and assert the value:

- **id:** `dod.1`
- **command:** a Node one-liner (or a committed helper `scripts/probe_mcp.mjs`) that spawns `npx --yes tsx packages/apigen/cli/src/index.ts run --source <real-api.ts> --type mcp`, connects an `@modelcontextprotocol/sdk` `StdioClientTransport`, calls `tools/list` then `callTool('getUser',{data:{userId:'abc'}})`, and **prints the JSON result**.
- **assertion:** output must contain all of `createUser getUser listUsers ping sendEmail` AND the exact substring `{"id":"abc","name":"Alice","role":"user"}` (order-insensitive JSON compare in the probe). Exit non-zero otherwise.
- **negative-control proof:** the audit doc must record that renaming the fixture export makes this check red (run once during plan authoring to prove teeth).

> Implementation: add `scripts/probe_mcp.mjs` (committed) so the check is `check("dod.1", "MCP tools/list + getUser value", "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs run")` and the probe does the JSON assertion and `process.exit(code)`. This removes the `test -f && nx test` proxy entirely.

**`dod.2` (replace `:537-541`)** — `probe_mcp.mjs generate-parity`: generate to `/tmp`, spawn the generated `server.ts`, call `callTool('getUser')`, spawn run-mode, call same, assert **JSON-equal**; exit non-zero on mismatch.

**`dod.5` (replace `:560-564`)** — `probe_mcp.mjs registry`: spawn `run-registry --packages-dir …/registry --tag api --type mcp`, assert `tools/list` ⊇ `{hello,world}`, asserts `internal ∉ tools`, asserts `callTool('hello')` text === `"a"`. Exit non-zero otherwise.

**`dod.7` (replace `:574-578`)** — two-run cache assertion:

```text
id: dod.7
command (conceptually):
  rm -rf <outDir> &&
  npx --yes nx reset >/dev/null &&
  OUT1=$(npx --yes nx run apigen-cli:generate-api) &&
  test -n "$(ls -A <outDir>)" &&            # files appeared
  HASH1=$(find <outDir> -type f -exec shasum {} \; | shasum) &&
  OUT2=$(npx --yes nx run apigen-cli:generate-api) &&
  echo "$OUT2" | grep -q -e 'local cache' -e 'from the cache' &&   # cache hit
  HASH2=$(find <outDir> -type f -exec shasum {} \; | shasum) &&
  [ "$HASH1" = "$HASH2" ]                    # identical files
assertion: all clauses true; check() keys on exit 0 of the whole pipeline.
```

**`dod.3` / `dod.4` (keep `nx test` but make the spec the source of teeth):** these stay `[structural]` ONLY if `contexts/integration-tests.md` mandates the named assertion AND a negative-control variant in `integration/schema.spec.ts`. Add a new audit check `audit-final.schema-teeth` that greps the spec for the required assertion tokens (`toContain('session')`, `not.toContain('ctx')`) so the gate fails if the implementer writes a vacuous schema spec. (This is a guard on the test, the lesser evil until the schema observable can be probed directly — note it for the caller.)

**New checks for coverage holes 2/3/5 (Part-A §2.5):**

- **id:** `dod.1-sse` — `probe_mcp.mjs run --transport streaming-http` (and `sse`): start HTTP MCP, `tools/list` over HTTP transport, assert same tool set. Closes hole #2.
- **id:** `plugin-cli-output.exec` — generate the CLI plugin output to `/tmp`, run `node /tmp/cli.js getUser --user-id abc`, assert stdout JSON === `{id:'abc',…}`. Closes hole #3.
- **id:** restore the 7 missing `integration-tests.*` runs (`.2 .4 .6 .7 .9 .11 .13`) by adding the corresponding `--testPathPattern` calls in `phase_integration()`, OR delete the unused IDs from the docstring (`:62-66`) so the registry doesn't overstate coverage. Closes hole #5. (Recommend: add the runs; the spec files are already declared in `dag.json:391-397`.)
- **id (optional, §6.5):** `dod.1-live` gated behind `APIGEN_LIVE=1` — run a real MCP client (or a real model via the SDK) through stdio and assert model-independent invariants (tool count, `getUser` round-trips). Default-skipped so CI stays offline. Closes hole #6.

### F4 — add a `## Value delta` section (before→after consumer observable)

**Target:** `README.md`. A `## Value-delta` table already exists at `README.md:30-38`, but the skill's 0.8.15 gate looks for a section literally named **`## Value delta`** (no hyphen) framed as before→after *consumer observable*. Add (or rename to) this canonical heading. Proposed content:

```markdown
## Value delta

| Consumer observable | Before | After |
|---|---|---|
| Expose a `.ts` file's functions as MCP tools | Hand-write a Server, register each tool, wire stdio transport (~150 LOC/project) | `npx @adhd/apigen-cli run --source api.ts --type mcp` — tools/list returns every export, zero source edits |
| Get an HTTP API for the same functions | Re-implement routes per framework | `--type api-fastify` or `--type api-express`, identical `POST /<id>/<fn>` shape |
| Ship generated server to disk | Copy boilerplate, maintain by hand | `generate … --out-dir ./out && node out/server.ts` — byte-identical behavior to `run` |
| Add a new function | Edit server wiring, restart | Re-run the same command |
| Compose multi-package surface | Manual server aggregation | `run-registry --tag api` discovers + wires by package tag |
```

Keep the existing `Value-delta` table or fold it in — confirm the gate's exact heading requirement (Open Question 3).

### F5 — map all work states into a DoD clause's `delivered-by`

**Target:** the `delivered-by:` fields added under F3 in `README.md`. Every one of the 17 work states must appear in at least one clause's `delivered-by` (free-floating states fail the gate). Proposed full mapping:

| DoD clause | delivered-by (work states) |
|---|---|
| `dod.1` | cli-run-cmd, plugin-mcp, runtime-dispatch, schema-extraction, runtime-middleware, integration-tests |
| `dod.2` | cli-generate-cmd, plugin-mcp, schema-extraction, schema-composition, integration-tests |
| `dod.3` | core-types, schema-extraction, integration-tests |
| `dod.4` | schema-composition, runtime-middleware, integration-tests |
| `dod.5` | cli-run-cmd, cli-generate-cmd, integration-tests |
| `dod.6` | scaffold-packages, scaffold-plugins, plugin-jsonschema, plugin-api-fastify, plugin-api-express, plugin-cli-output, nx-generator |
| `dod.7` | nx-generator, cli-generate-cmd |
| `dod.8` | nx-generator, scaffold-plugins |

**Coverage check of all 17 work states:** scaffold-packages ✓(6), core-types ✓(3), schema-extraction ✓(1/2/3), schema-composition ✓(2/4), runtime-middleware ✓(1/4), runtime-dispatch ✓(1), scaffold-plugins ✓(6/8), plugin-jsonschema ✓(6), plugin-mcp ✓(1/2), plugin-api-fastify ✓(6), plugin-api-express ✓(6), plugin-cli-output ✓(6) — **and** should also be added to a new CLI-output behavioral clause if hole #3 is accepted, cli-generate-cmd ✓(2/5/7), cli-run-cmd ✓(1/5), nx-generator ✓(6/7/8), integration-tests ✓(1–5). All 17 mapped. (`plugin-jsonschema`, `plugin-api-fastify/express`, `plugin-cli-output` are only mapped via the structural `dod.6` build clause; if the caller wants behavioral coverage for jsonschema/cli-output, add the new checks from F3 — recommended, since "builds" is the weakest possible delivery proof for these.)

### F6 — interfaces.json: correct to the 0.8.15 schema

**Target:** `interfaces.json`. Every entry fails three ways: (a) required field `interface` is null/empty (entries use legacy `shape`), (b) `confidence:"high"` is not in enum `verified|vendored|documented|assumed`, (c) `provenance:"vendored-source"` should be `vendored`. Corrected shape per entry (showing `mcp-sdk`; apply identically to all 7):

```json
{
  "mcp-sdk": {
    "provenance": "vendored",
    "confidence": "vendored",
    "resolved_version": "see packages/apigen/plugins/mcp/package.json (@modelcontextprotocol/sdk)",
    "source": "node_modules/@modelcontextprotocol/sdk/dist/index.d.ts",
    "interface": {
      "Server": "new Server({ name, version }, { capabilities: { tools: {} } })",
      "StdioServerTransport": "new StdioServerTransport()",
      "SSEServerTransport": "new SSEServerTransport(path, res)",
      "StreamableHTTPServerTransport": "new StreamableHTTPServerTransport({ sessionIdGenerator? })",
      "server.setRequestHandler": "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...] }))",
      "tool_shape": "{ name: string, description: string, inputSchema: JSONSchema }",
      "CallToolRequest": "{ params: { name: string, arguments: Record<string, unknown> } }",
      "server.connect": "await server.connect(transport: Transport)",
      "key_api_note": "SDK ships all three transports …"
    },
    "cited_by": ["plugin-mcp"]
  }
}
```

**Per-entry corrections (all in `interfaces.json`):**

| entry | line | `provenance` | `confidence` | rename `shape`→`interface` |
|---|---|---|---|---|
| `ts-morph` | :2-15 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `ts-json-schema-generator` | :17-29 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `mcp-sdk` | :30-47 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `nx-devkit` | :48-65 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `commander` | :66-81 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `fastify` | :82-95 | `vendored-source`→`vendored` | `high`→`vendored` | yes |
| `express` | :96-111 | `vendored-source`→`vendored` | `high`→`vendored` | yes |

> All 7 entries cite a real `node_modules/.../*.d.ts` `source`, so `vendored` is the correct provenance+confidence (the d.ts was read). If any was not actually opened during authoring, downgrade that one to `documented`/`assumed` — but the `source` paths imply `vendored` is honest.

### F8 — dag.json tiers: add `model` + `effort` per state

**Target:** `dag.json`. All 23 nodes are `unrated` (no `model`/`effort` keys). Proposed annotations by node kind: implementation→`sonnet`/`medium`; audits, reviews, human checkpoints→`opus`/`hard`; pure scaffolding→`sonnet`/`low` (haiku is risky for nx generator wiring, so scaffold-*=sonnet/low not haiku).

| state | kind | model | effort | rationale |
|---|---|---|---|---|
| scaffold-packages | work (scaffold) | sonnet | low | mechanical nx scaffolding |
| core-types | work | sonnet | medium | type design, contracts |
| schema-extraction | work | sonnet | medium | ts-morph algorithm |
| schema-composition | work | sonnet | medium | envelope merge logic |
| audit-core | audit | opus | hard | gate correctness |
| runtime-middleware | work | sonnet | medium | event bus, recursion guard |
| runtime-dispatch | work | sonnet | medium | single-path dispatch |
| audit-runtime | audit | opus | hard | gate |
| scaffold-plugins | work (scaffold) | sonnet | low | runs generator ×5 |
| plugin-api-fastify | work | sonnet | medium | reference plugin |
| plugin-fastify-checkpoint | audit (human gate) | opus | hard | human-presented review |
| plugin-jsonschema | work | sonnet | low | simplest plugin, no run() |
| plugin-mcp | work | sonnet | medium | 3 transports |
| plugin-api-express | work | sonnet | medium | HTTP plugin |
| plugin-cli-output | work | sonnet | medium | commander codegen |
| audit-plugins | audit (reviewer gate) | opus | hard | gate + code-reviewer |
| cli-generate-cmd | work | sonnet | medium | pipeline wiring |
| cli-run-cmd | work | sonnet | medium | live import + run |
| nx-generator | work | sonnet | medium | devkit generator+executor |
| audit-cli | audit | opus | hard | e2e gate |
| integration-tests | work | sonnet | medium | 14 behavioral tests |
| audit-final | audit | opus | hard | DoD proofs |
| done | terminal | sonnet | low | no-op |

Add as `"model": "...", "effort": "..."` keys on each node in `dag.json`.

### F2 — DO NOT stamp the DoD (flag only)

**Target:** `state.json:5` `"dod_provenance": null`. The DoD has never been confirmed with the requester. Per instructions I am **not** running `--confirm-dod` and **not** editing `state.json`. The caller must confirm the final DoD wording (especially the F3-amended clauses, the F4 value-delta phrasing, and whether to add a behavioral CLI-output clause) **before** `dod_provenance` is stamped. See Open Questions.

---

## 4. Open questions for the caller

1. **DoD wording (F2/F3):** Approve the six amended clauses (`dod.1-5,7` gaining `delivered-by`+`negative-control`) and the rewritten audit checks? Specifically: is the headline value `{"id":"abc","name":"Alice","role":"user"}` (`README.md:69`) the exact assertion you want hard-coded into `probe_mcp.mjs`?
2. **CLI-output behavioral clause (hole #3):** Add a new `dod` clause that *executes* generated CLI output and asserts its result, or is "builds cleanly" (current `dod.6` coverage) acceptable for `plugin-cli-output` and `plugin-jsonschema`? My recommendation: add it — "builds" is the weakest delivery proof and these two plugins have no behavioral gate otherwise.
3. **env-pin marker form (F1) + value-delta heading (F4):** Which marker does `scripts/env-pin-check.js` accept for non-tool gates — an `npx --yes` prefix or a `# guard-less-gate:` sentinel? And does the 0.8.15 gate require the literal heading `## Value delta` (vs the existing `## Value-delta`)? I need the exact tokens before applying, to avoid a second red preflight.
4. **MCP transport coverage (hole #2):** Add SSE / streamable-HTTP probes now, or scope MCP to stdio for v1 and defer the other transports (currently declared in `dag.json:243` and `_shared.md:201` but untested)?
5. **Missing integration IDs (hole #5):** Add the 7 unrun `integration-tests.*` checks (`.2 .4 .6 .7 .9 .11 .13`), or delete them from the docstring registry so coverage isn't overstated?
6. **Live-model test (§6.5, hole #6):** Add an `APIGEN_LIVE=1`-gated real end-to-end MCP check, or accept SDK-client-only coverage for v1?
