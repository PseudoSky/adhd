# Final Review Checklist — apigen-client-generation

Completed before dispatch. Each item is checked (✅) or flagged (❌).

---

## Step 7 Checklist

### Plan integrity

- ✅ **dag.json is valid** — 23 nodes, all slugs unique, all `depends_on` reference real nodes, terminal `done` node present
- ✅ **state.json is aligned** — all 23 slugs from dag.json present in state.json at `pending`, `current_state = scaffold-packages`
- ✅ **Every work state has a context file** — 23/23 contexts written (incl. scaffold-plugins, plugin-fastify-checkpoint, integration-tests)
- ✅ **Every audit state has numbered checks** — audit-core (10), audit-runtime (9), audit-plugins (7), audit-cli (10), integration-tests (14), audit-final (8 DoD checks + 4 invariant sweeps)
- ✅ **All context files have File Reservations** — `mutates` and `read_only` sections present
- ✅ **All context files have Acceptance Criteria** — IDed `[state.N]` entries
- ✅ **All context files have Commit Points** — at least one commit message per state

### Parallel safety

- ✅ **Parallel states share no mutable files** — runtime-middleware || runtime-dispatch (both touch index.ts → MERGE PROTOCOL documented); all other parallel groups are file-isolated
- ✅ **MERGE PROTOCOL documented** — runtime-dispatch.md + cli-run-cmd.md both have explicit merge protocol notes
- ✅ **Parallel groups all converge at an audit barrier** — foundation→audit-core, runtime→audit-runtime, plugins→audit-plugins, cli→audit-cli

### Reference catalog

- ✅ **references.json is flat slug-keyed** (no schema_version wrapper, 8 entries)
- ✅ **Every ref has audit_check** — all 8 entries have `audit_check` field
- ✅ **All ref files exist in reference codebase** — verified against REFERENCES.md reading order
- ✅ **No ref prose restated in work states** — states cite `[ref:slug]` only

### Interface catalog

- ✅ **interfaces.json covers all external deps** — ts-morph, ts-json-schema-generator, @modelcontextprotocol/sdk, @nx/devkit, commander, fastify, express (7 entries)
- ✅ **All have provenance, confidence, shape** — all at `vendored-source` / `high`
- ✅ **key_api_note included** — every entry has a note for executors

### DoD coverage

- ✅ **[dod.1]** → `audit-final` §dod.1 check (generate writes files)
- ✅ **[dod.2]** → `audit-final` §dod.2 check (run starts server)
- ✅ **[dod.3]** → `audit-final` §dod.3 check (ctx excluded)
- ✅ **[dod.4]** → `audit-final` §dod.4 check (data wrapper)
- ✅ **[dod.5]** → `audit-final` §dod.5 check (false override)
- ✅ **[dod.6]** → `audit-final` §dod.6 check (all 5 plugins pass)
- ✅ **[dod.7]** → `audit-final` §dod.7 check (language-agnostic)
- ✅ **[dod.8]** → `audit-final` §dod.8 check (Nx generator)

### Invariant coverage

- ✅ **[inv:ctx-name-only]** → `audit-core.9`, `audit-final.inv-ctx-name-only`
- ✅ **[inv:data-wrapper-always-present]** → `audit-core.10`, `audit-final.dod.4`
- ✅ **[inv:false-suppresses-middleware]** → `audit-final.dod.5`
- ✅ **[inv:dispatch-single-path]** → `audit-runtime.9`, `audit-plugins.4/5`, `audit-final.inv-dispatch-single-path`
- ✅ **[inv:type-flag-only]** → `audit-plugins.6`, `audit-cli.4`, `audit-final.inv-type-flag-only`
- ✅ **[inv:language-agnostic-output]** → `audit-final.inv-language-agnostic-output`
- ✅ **[inv:nx-platform-tags]** → `audit-final.inv-nx-platform-tags`, `nx-generator.2`

### Brownfield completeness

- ✅ **plan_kind = brownfield** — dag.json meta correct
- ✅ **spec_sources includes SCOPE.md and REFERENCES.md** — both listed in dag.json
- ✅ **Reference codebase table in _shared.md** — `[ref:reference-codebase]` with per-concern file list
- ✅ **API divergences documented** — `eventMapping` redesign, `--type` rename, MCP consolidation all in _shared.md table
- ✅ **Each context cites specific reference files** — not generic "look at the reference codebase"

### Script availability

- ✅ **audit_apigen.py written** — 6 phases (integration added), all checks implemented
- ✅ **gap-check.js copied** — from sox-subagents workflow 0.8.11
- ✅ **env-pin-check.js copied** — from sox-subagents workflow 0.8.11

---

## Known gaps / explicit deferred items

None. All states are fully specified. The following are implementation-time decisions (not planning gaps):

1. **Exact ts-json-schema-generator version** — executor should read from `node_modules/ts-json-schema-generator/package.json` to confirm installed version; plan cites vendored source.
2. **MCP SDK transport API stability** — plan cites `@modelcontextprotocol/sdk/dist/index.d.ts`; if the SDK changes major version, executor updates transport call sites per interfaces.json shape.
3. **morph-fallback depth** — SCOPE.md suggests depth-6; executor may tune based on test fixture complexity.

---

## Dispatch decision (from Step 1b)

**Automatic dispatch:** No — hand off with Dispatch line. User must trigger execution.

**Executor:** Single agent per state, sequentially within a phase. Parallel states within a phase may be executed by separate agents if desired — MERGE PROTOCOL handles shared files.

**Reviewer gates:** `code-reviewer` after audit-plugins; `architect-reviewer` after audit-final.

---

## Hand-off command

```bash
node docs/plan/apigen-client-generation/scripts/gap-check.js docs/plan/apigen-client-generation/
```

Then, to begin execution:

```bash
# Read state.json → current_state = scaffold-packages
# Open: docs/plan/apigen-client-generation/contexts/scaffold-packages.md
# Execute the state, run its guard, commit, advance state.json
```
