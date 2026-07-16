# 🎬 agent-final — Live Demo & Acceptance Script

> Author an agent fleet from shared, versioned parts — change a rule once and every agent, every compile, and every dispatched wave picks it up; then delete an agent and leave zero orphaned state behind.

**What this is.** A presentation-grade walkthrough of the consolidated agent+dispatch system that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the system the way a brand-new fleet owner would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means for the **agent-final** plan: beats that run green today are the shipped core; beats tagged ⟦U#⟧ are the remaining work — if it's demonstrated here, it must work; if it must work, it's demonstrated here. Two earlier demos are **nested gates** inside this one: [`../store-move/DEMO.md`](../store-move/DEMO.md) (runtime store fold) and [`../superseded/dispatch-completion/demo/DEMO.md`](../superseded/dispatch-completion/demo/DEMO.md) (the dispatcher, retained by owner ruling O-3) — this spine exercises their seams and requires their sign-offs; it does not repeat their depth.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (command) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (IDs, timestamps) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies (traceability). |
| 📎 **Source** | What grounds this step — spec section, doc, file, ticket, or URL. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context didn't specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- Shell prompt is `$`; all commands run from the repo root (`/Users/nix/dev/node/adhd`) unless noted.
- MCP tool calls go through the demo's real stdio client — a thin JSON-RPC driver against the **unmodified built server** (never an import of server internals):
  ```bash
  alias mcp='node docs/plan/agent-final/demo/call-tool.mjs'   # mcp <tool_name> '<json-args>'
  ```
  `call-tool.mjs` is part of this demo's harness manifest (§2.2) and speaks real `initialize` → `tools/call` over stdio to `dist/entrypoint/agent-mcp/src/index.js`.
- The demo database is `tmp/agent-mcp/agent-final-demo.db` via `DATABASE_PATH` — never a tracked path.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file — confirm them before treating the step as authoritative.
- Gate on **exit codes**, never piped-grep of stdout.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Noa owns a fleet of forty reviewer and auditor agents. They live as forty near-identical markdown prompts, and every fleet-wide rule change means forty hand edits, forty chances to drift, and no way to know which agents actually carry the current rule. Her runtime is no more honest: deleting an agent leaves its old sessions haunting the database, and the dispatch system that farms out her plan waves speaks to the agent runtime through a hand-mirrored copy of its wire types that goes stale on every release. She wants what a package registry gave code: **author a part once, version it, share it, search it, and trace every running instance back to it.**

> **The promise we'll prove in the next ~20 minutes:** define a rule component once — every agent that shares it recompiles with the new text from a single edit, a dispatched wave runs with it, deleting an agent cascades cleanly to zero orphaned state, and the whole registry is searchable through published sox packages with **zero retrieval code in this repo**.

🔗 **Proves (framing):** REQ-001, REQ-002, REQ-005 · CAP-001, CAP-002, CAP-003
📎 **Source:** GOAL.md "The vision" + "The end state"; SYNTHESIS.md §Settled (separability intent).

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Noa

Noa is an agent-platform owner. Her goal this session: rebuild two of her fleet's agents from shared components, prove one edit reaches both, run one for real, dispatch a wave through the same machinery, and satisfy herself that deleting an agent leaves nothing behind. The stakes: at her fleet size, prompt drift is a compliance problem and orphaned sessions are a forensic one. **Also appearing:** Priya, the dispatch lead from the nested dispatcher demo — her plan files get wired to Noa's agents in Act 5.

### 2.2 The Canonical Demo Dataset

The single source of data truth for this script. Components (type `rule`/`identity` must exist in `prompt_types`):

| Component | type | shared | content v1 |
|---|---|---|---|
| `shared-grounding-rule` | rule | yes | `Numbers MUST come from tool output, never estimates.` |
| `reviewer-identity` | identity | no | `You are a meticulous code reviewer. Verdicts default to NEEDS-WORK.` |
| `crit-security` | rule | no | `SECURITY CRITERIA: validate all inputs at the boundary; check authz.` — junction `context_condition` `{"ticket_type":"security"}` |

Agents (both attach `shared-grounding-rule` **unpinned** — this is what makes the climax fire):

| Agent | components (position order) | tools |
|---|---|---|
| `demo-reviewer` | reviewer-identity · crit-security (conditional) · shared-grounding-rule (unpinned) | `Read`, `Grep` |
| `demo-auditor` | reviewer-identity · shared-grounding-rule (unpinned) | `Read` |

The v2 bump text (climax): `Numbers MUST cite file:line or tool output — estimates are defects.`
Dispatch fixture: `../superseded/dispatch-completion/demo/fixtures/sample-plan.dag.json` (`schema_version: 4`, scaffold→implement→verify), copied to `/tmp/agent-final-demo/` before any mutation.
Harness manifest (files beside this script, built by the plan): `call-tool.mjs` (real stdio MCP client), `seed-registry.mjs` (60-component bulk seed for the bounded-output beat).

### 2.3 Prerequisites

- Node ≥ 20, repo deps installed (`npm ci`), no network needed except the two flagged live beats.
- `@adhd/sox-graph-store` + `@adhd/sox-hybrid-search` published and installed as dependencies of `agent-store-prompts` (the sox-side publish is in flight — a landed precondition of this plan, not its scope; same pattern as the nested dispatch demo's §2.3).
- **Policy note (owner ruling O-1):** `agent-core-policy` is on hold — this demo deliberately contains **no enforcement beat** and asserts nothing about policy gating.

### 2.4 Cold Start — From Nothing to Running

🎬 **Scene.** Noa builds the stack and asks the host what it can do.

▶️ **Do**
```bash
npx nx run-many -t build -p agent-store-runtime,agent-store-prompts,agent-engine-compiler,agent-engine-orchestrator,agent-mcp
mkdir -p tmp/agent-mcp && export DATABASE_PATH=tmp/agent-mcp/agent-final-demo.db
alias mcp='node docs/plan/agent-final/demo/call-tool.mjs'
mcp guide '{}' | tee /tmp/agent-final-demo/tools-before.txt
```

👀 **Expect** — build exits 0 for all five projects; the tool listing shows the runtime surface:
```
agent_create agent_read agent_update agent_delete agent_list
agent session_list session_close session_clear
task task_list task_cancel task_resume result usage_query guide
component_define component_delete component_search component_read agent_define agent_compile ⟨…discovery list⟩
```

✅ **Verify**
- [ ] `nx run-many … build` exits 0 for all five projects.
- [ ] The 15 runtime tools listed in `server.ts:445-538` are ALL present, with unchanged names.
- [ ] The tool listing is captured to `tools-before.txt` (compared byte-for-byte in §5.4).

🔗 **Proves:** REQ-007 · CAP-010
📎 **Source:** `entrypoint/agent-mcp/src/server.ts:445-538` (the 15 verified tools); authoring-lane tool names ⟦U1⟧ inferred — see UNRESOLVED.md.

---

## 3 · The Journey

### Act 1 — A fleet from parts

Noa stops editing forty files and starts defining parts.

#### 1.1 · Define the shared parts once   (happy)

🎬 **Scene.** Three components: an identity, a conditional security rule, and the grounding rule her whole fleet must share.

▶️ **Do**
```bash
mcp component_define '{"name":"shared-grounding-rule","type":"rule","content":"Numbers MUST come from tool output, never estimates.","shared":true}'
mcp component_define '{"name":"reviewer-identity","type":"identity","content":"You are a meticulous code reviewer. Verdicts default to NEEDS-WORK."}'
mcp component_define '{"name":"crit-security","type":"rule","content":"SECURITY CRITERIA: validate all inputs at the boundary; check authz."}'
```

👀 **Expect** (each)
```json
{"name":"shared-grounding-rule","version":1,"changed":true,"summary":"⟨auto-derived⟩"}
```

✅ **Verify**
- [ ] All three return `version: 1`, `changed: true`, exit 0.
- [ ] Re-running the first command byte-identical returns `changed: false` and version stays 1 (idempotent, no churn).

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** superseded/agent-mcp-authoring README.md:122-129 (component_define contract; plan unbuilt) — ⟦U1⟧ see UNRESOLVED.md.

#### 1.2 · Compose two agents that share a rule   (happy)

🎬 **Scene.** Two agents, one shared unpinned rule between them. This wiring is the whole demo's fuse.

▶️ **Do**
```bash
mcp agent_define '{"name":"demo-reviewer","model":"sonnet","components":[{"name":"reviewer-identity"},{"name":"crit-security","context_condition":{"ticket_type":"security"}},{"name":"shared-grounding-rule"}],"tools":["Read","Grep"]}'
mcp agent_define '{"name":"demo-auditor","model":"sonnet","components":[{"name":"reviewer-identity"},{"name":"shared-grounding-rule"}],"tools":["Read"]}'
```

👀 **Expect**
```json
{"name":"demo-reviewer","changed":true,"composed_prompt_id":"⟨id⟩","compiled_preview":"⟨identity, then rules, in position order⟩"}
```

✅ **Verify**
- [ ] Both agents created, exit 0; `compiled_preview` shows components in the declared position order.
- [ ] `component_consumers` for `shared-grounding-rule` lists exactly `demo-reviewer` and `demo-auditor`.

🔗 **Proves:** REQ-001, REQ-003 · CAP-002
📎 **Source:** superseded/agent-mcp-authoring decisions.md:167-186 (agent_define transactional upsert) — ⟦U2⟧ see UNRESOLVED.md.

#### 1.3 · A typo can't half-create an agent   ⚠️ (edge)

🎬 **Scene.** Noa fat-fingers a component name. The registry must stay byte-identical — no partial writes.

▶️ **Do**
```bash
mcp agent_define '{"name":"demo-broken","model":"sonnet","components":[{"name":"does-not-exist"}]}'
mcp agent_read '{"name":"demo-broken"}'
```

👀 **Expect** — first call: structured error `COMPONENT_NOT_FOUND: does-not-exist`; second call: `AGENT_NOT_FOUND`.

✅ **Verify**
- [ ] The failed define leaves no agent row, no junction rows (`agent_read` → `AGENT_NOT_FOUND`).
- [ ] The error names the missing component exactly.

🔗 **Proves:** REQ-001 · CAP-002
📎 **Source:** superseded/agent-mcp-authoring contexts/agent-define.md:55-58 (typed rollback) — ⟦U2⟧ see UNRESOLVED.md.

#### 1.4 · The old flat path still works   (happy)

🎬 **Scene.** Priya's tooling still calls `agent_create` with a flat prompt. Zero-regression is a promise, not a hope.

▶️ **Do**
```bash
mcp agent_create '{"name":"legacy-flat","provider":{"type":"claudecli"},"systemPrompt":"You are a terse changelog writer."}'
mcp agent_read '{"name":"legacy-flat"}'
```

👀 **Expect** — create succeeds exactly as on agent-mcp 2.1.x; read returns the agent with its flat prompt intact.

✅ **Verify**
- [ ] `agent_create` with `systemPrompt` succeeds; `agent_read` round-trips it.
- [ ] Supplying BOTH `systemPrompt` and `components` in one call is rejected with `VALIDATION_ERROR`.

🔗 **Proves:** REQ-013 · CAP-012
📎 **Source:** `entrypoint/agent-mcp/src/server.ts:545` (agent_create routing, verified live surface); compat-shim semantics ⟦U2⟧ — see UNRESOLVED.md.

### Act 2 — Find, don't rebuild

The registry is only as good as its search — and the search must not be ours.

#### 2.1 · Ask for a capability, get the right part   (happy)

🎬 **Scene.** Noa can't remember what the grounding rule is called. She describes what it does.

▶️ **Do**
```bash
mcp component_search '{"query":"numbers must come from real tool output not guesses"}'
```

👀 **Expect**
```json
{"results":[{"name":"shared-grounding-rule","score":⟨0.xx⟩,"summary":"⟨…⟩"},…],"degraded":null}
```

✅ **Verify**
- [ ] `shared-grounding-rule` is rank 1 despite zero exact keyword overlap ("guesses" vs "estimates" — the vector channel earns its keep).
- [ ] Results are summary projections (no full component bodies inline).
- [ ] `degraded` is null/absent — both channels (FTS5 + vector) were live.

🔗 **Proves:** REQ-002 · CAP-003
📎 **Source:** hybrid retrieval = sox `SqliteSearchBackend` over `kind:'generic'` graph-store nodes per decisions.md §D6 FLIP (Option A) + sox BL-295 Option-A contract; `degraded` field shipped in sox-hybrid-search 2026-07-16 (fixer commit `65dad22`) — ⟦U3⟧ see UNRESOLVED.md.

#### 2.2 · Zero retrieval code in this repo — the no-workaround audit   (happy)

🎬 **Scene.** The rule that keeps this system honest: adhd consumes sox's retrieval, it never rebuilds it. Grep is the auditor.

▶️ **Do**
```bash
grep -rniE "cosine|embedSingle|sqlite-vec|fts5|CREATE VIRTUAL TABLE" packages/agent --include="*.ts" | grep -v __tests__ | wc -l
node -e "const p=require('./packages/agent/agent-store-prompts/package.json'); console.log(Object.keys(p.dependencies).filter(d=>d.startsWith('@adhd/sox-')).join('\n'))"
```

👀 **Expect**
```
0
@adhd/sox-graph-store
@adhd/sox-hybrid-search
```

✅ **Verify**
- [ ] Zero retrieval-implementation hits in `packages/agent` source (count is literally `0`).
- [ ] The sox packages appear as real published dependencies (`npm view @adhd/sox-graph-store version` exits 0).

🔗 **Proves:** REQ-002 · CAP-003
📎 **Source:** owner ruling D-A (GOAL.md); baseline verified: zero embedding/vector/fts5 code and zero @adhd/sox refs exist today (OBSERVATIONS OBS-5) — the assertion keeps it that way while adding the deps; publish in flight ⟦U3⟧.

### Act 3 — Compile: deterministic, cached, per-platform

#### 3.1 · One agent, two platforms, three contexts   (happy)

🎬 **Scene.** The same `demo-reviewer` must render as YAML frontmatter for claude_code and JSON for the API — and the security criteria must appear only when the ticket is a security ticket.

▶️ **Do**
```bash
mcp agent_compile '{"name":"demo-reviewer","platform":"claude_code","context":{"ticket_type":"security"}}' > /tmp/agent-final-demo/rev.code.security.txt
mcp agent_compile '{"name":"demo-reviewer","platform":"claude_code","context":{}}'                          > /tmp/agent-final-demo/rev.code.empty.txt
mcp agent_compile '{"name":"demo-reviewer","platform":"claude_api","context":{"ticket_type":"security"}}'   > /tmp/agent-final-demo/rev.api.security.json
```

👀 **Expect** — first output starts `---` (frontmatter) and contains `SECURITY CRITERIA`; second contains **no** `SECURITY CRITERIA`; third is `JSON.parse`-able with `systemPrompt`/`tools`/`model` and platform tool aliases.

✅ **Verify**
- [ ] Conditional include/exclude: `grep -c "SECURITY CRITERIA" rev.code.security.txt` = 1 and `…empty.txt` = 0.
- [ ] Format dispatch is column-driven: yaml vs JSON per platform, same registry rows.
- [ ] Components appear in junction position order in both formats.

🔗 **Proves:** REQ-003 · CAP-005
📎 **Source:** the deterministic composition stack is real and verified (SYNTHESIS §1.3: all four stores, junction ordering, exact-match context rules); `agent_compile` tool shape ⟦U4⟧ — see UNRESOLVED.md.

#### 3.2 · The cache tells the truth   (happy)

▶️ **Do**
```bash
mcp agent_compile '{"name":"demo-reviewer","platform":"claude_code","context":{"ticket_type":"security"}}' 
```

👀 **Expect** — response carries `"cache":"HIT"` and the **same** `composed_prompt_id` as beat 3.1's first compile.

✅ **Verify**
- [ ] Recompile with identical inputs is a cache HIT with an unchanged `composed_prompt_id` (SHA-keyed lookup-before-assembly).

🔗 **Proves:** REQ-004 · CAP-005
📎 **Source:** SHA-256-keyed `registry_composed_prompts` cache verified real (SYNTHESIS §1.3); HIT/MISS response field ⟦U4⟧.

### Act 4 — Run it for real

#### 4.1 · A task through the real orchestrator   (happy)

🎬 **Scene.** `demo-reviewer` gets its first job. Structural path runs unflagged; the paid model completion is the one legitimate env-gate.

▶️ **Do**
```bash
mcp agent '{"agent_name":"demo-reviewer"}'                      # → session ⟨s1⟩
mcp task '{"session_id":"⟨s1⟩","input":"Review: function add(a,b){return a-b}"}'
mcp result '{"task_id":"⟨t1⟩"}'
# paid live variant (the one legitimate gate):
AGENT_MCP_LIVE=1 mcp result '{"task_id":"⟨t1⟩","wait":true}'
```

👀 **Expect** — unflagged: session row created, task accepted, status transitions `pending→running`; flagged: `stopReason: completed`, a NEEDS-WORK verdict mentioning the subtraction bug, `usage_query` shows `tokens > 0` for the task.

✅ **Verify**
- [ ] Session and task rows exist in `tmp/agent-mcp/agent-final-demo.db` (sqlite3 count = 1 each) — real store, real orchestrator.
- [ ] With `AGENT_MCP_LIVE=1`: the completion is in-character (identity + grounding rule present in conduct) and `usage_query` records real tokens.

🔗 **Proves:** REQ-006 · CAP-006
📎 **Source:** `agent`/`task`/`result`/`usage_query` tools verified live (`server.ts:598,638,680,688`); AGENTS.md §"Live testing is mandatory" (paid-model gate).

#### 4.2 · The budget plugin loads by NAME and bites   ⚠️ (edge)

🎬 **Scene.** No code change, no import — a deployment decision caps the spend, and the cap actually fires.

▶️ **Do**
```bash
ADHD_AGENT_PLUGINS='[{"module":"@adhd/agent-plugin-budget","config":{"maxModelCalls":1}}]' \
  mcp task '{"session_id":"⟨s1⟩","input":"Now write a 10-part epic poem about linting."}'
```

👀 **Expect** — the task halts after one model call with a structured budget error naming the exceeded limit; the session survives.

✅ **Verify**
- [ ] The second model call is blocked; task status is `failed` with a budget-limit error, not a crash.
- [ ] Removing the env var and re-running the same task completes normally (the plugin was the cause — negative control).

🔗 **Proves:** REQ-009 · CAP-009
📎 **Source:** runtime by-name loading verified (`agent-engine-orchestrator/src/plugins/loader.ts:260-281`, `ADHD_AGENT_PLUGINS`); budget config keys ⟦U5⟧ — see UNRESOLVED.md.

### Act 5 — One client, two hosts

#### 5.1 · Priya's dispatcher fires a wave through the SAME machinery   (happy)

🎬 **Scene.** The seam this consolidation exists for: dispatch stops speaking a hand-mirrored dialect and calls the agent client in-process.

▶️ **Do**
```bash
mkdir -p /tmp/agent-final-demo && cp docs/plan/agent-final/superseded/dispatch-completion/demo/fixtures/sample-plan.dag.json /tmp/agent-final-demo/spine.dag.json
npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/bin/cli.ts run --dag-path /tmp/agent-final-demo/spine.dag.json --runner in-process
mcp task_list '{"limit":5}'
```

👀 **Expect** — `{ dispatched: [...], persisted: true }`; `task_list` shows the dispatched unit's task **in the same `DATABASE_PATH` store** with the plan's agent name.

✅ **Verify**
- [ ] The dispatched wave's task appears in the same runtime DB the MCP host uses — one client, one store, no wire mirror.
- [ ] `dispatch eligible` on the post-run dag advances (scaffold no longer eligible).

🔗 **Proves:** REQ-008 · CAP-008
📎 **Source:** dispatch CLI `run` verified (`bin/cli.ts:120-131`); `--runner in-process` + the in-process client path ⟦U6⟧ inferred from arch doc §3b target — see UNRESOLVED.md.

#### 5.2 · The mirrored dialect is dead   (happy)

▶️ **Do**
```bash
grep -cE "interface (AgentCreateArgs|TaskArgs|ResultShape)" packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts || echo 0
grep -c "agent_create" packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts || echo 0
```

👀 **Expect**
```
0
0
```

✅ **Verify**
- [ ] The locally-mirrored wire types (today at `agent-runner.ts:19-102`) are gone.
- [ ] The bare-`agent_create` authoring path (today at `:353-373`) is gone — agents are authored only through the registry lane.

🔗 **Proves:** REQ-008 · CAP-008
📎 **Source:** owner-settled (SYNTHESIS §Settled: "Dispatch USES the agent client… delete the mirrored wire types"); current line numbers verified in `agent-runner.ts`.

#### 5.3 · Nested gate: the dispatcher's own demo   (happy)

▶️ **Do** — run [`../superseded/dispatch-completion/demo/DEMO.md`](../superseded/dispatch-completion/demo/DEMO.md) top to bottom and fill its §9 sign-off.

✅ **Verify**
- [ ] Its sign-off records **PASS** (every ✅ ticked, its 15 ⟦U#⟧ items landed or explicitly risk-accepted per its own rules).

🔗 **Proves:** REQ-012 · CAP-008
📎 **Source:** owner ruling O-3 (GOAL.md): demo retained as the dispatch milestone's acceptance frame.

---

## 4 · The Climax — Change once, everywhere; then leave no trace

🎬 **Scene.** The payoff. Noa's compliance team upgrades the grounding rule. In the old world: forty file edits. Here: **one** `component_define`. Both agents recompile with the new text from that single write, a dispatched wave runs carrying it — and then Noa retires an agent and the system forgets it *completely*.

▶️ **Do**
```bash
# ONE edit
mcp component_define '{"name":"shared-grounding-rule","type":"rule","content":"Numbers MUST cite file:line or tool output — estimates are defects.","shared":true}'
# both agents recompile — drift MISS, new text, from one write
mcp agent_compile '{"name":"demo-reviewer","platform":"claude_code","context":{}}' > /tmp/agent-final-demo/rev.v2.txt
mcp agent_compile '{"name":"demo-auditor","platform":"claude_code","context":{}}'  > /tmp/agent-final-demo/aud.v2.txt
# a dispatched wave carries it
npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/bin/cli.ts run --dag-path /tmp/agent-final-demo/spine.dag.json --runner in-process
# retire an agent — the runtime must forget it completely
mcp agent '{"agent_name":"demo-auditor"}'          # open session ⟨s2⟩ to arm the guard
mcp agent_delete '{"name":"demo-auditor"}'          # → AGENT_HAS_ACTIVE_SESSIONS
mcp session_close '{"session_id":"⟨s2⟩"}'
mcp agent_delete '{"name":"demo-auditor"}'          # → deleted
sqlite3 tmp/agent-mcp/agent-final-demo.db "SELECT COUNT(*) FROM sessions WHERE agent_name='demo-auditor';"
```

👀 **Expect**
```
version: 2, changed: true
rev.v2.txt + aud.v2.txt BOTH contain "estimates are defects"   (cache: MISS, drift)
dispatched unit's compiled prompt contains "estimates are defects"
ToolError AGENT_HAS_ACTIVE_SESSIONS  →  (close)  →  deleted
0
```

✅ **Verify**
- [ ] ONE `component_define` changed BOTH agents' compiled output (grep the v2 phrase in both files) — pinned components elsewhere unchanged.
- [ ] Both recompiles were cache **MISS** with new `composed_prompt_id`s (unpinned drift busts the cache; 3.2's HIT proves the tooth cuts both ways).
- [ ] The dispatched task's prompt carries the v2 text — authoring → compile → dispatch is one connected system.
- [ ] `agent_delete` with an open session throws `AGENT_HAS_ACTIVE_SESSIONS`; after close+delete, orphaned session count is literally `0` (the FK cascade — through real tools, not SQL bypass).
- [ ] **Nested gate:** [`../store-move/DEMO.md`](../store-move/DEMO.md) sign-off records PASS (FK disarm proof: `drizzle-kit generate` emits nothing; negative controls included).

🔗 **Proves:** REQ-004, REQ-005, REQ-006, REQ-011 · CAP-001, CAP-005, CAP-007, CAP-008
📎 **Source:** single-authorship + drift semantics verified real in the composition stack (SYNTHESIS §1.3); cascade restored by migration 0009 + fold plan (OBSERVATIONS OBS-1, store-move/GOAL.md); `AGENT_HAS_ACTIVE_SESSIONS` verified (`agent-store.ts:131-132`); compile/response shapes ⟦U4⟧.

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ The tests actually run — no more silent green

▶️ **Do**
```bash
npx nx run-many -t test -p dispatch-core-optimizer,agent-plugin-budget,agent-plugin-sanitize; echo "EXIT=$?"
node -e "for (const p of ['packages/dispatch/dispatch-core-optimizer','packages/agent/agent-plugin-budget','packages/agent/agent-plugin-sanitize']) { const t=require('./'+p+'/project.json').targets; if(!t.test) { console.error('MISSING test target: '+p); process.exit(1);} } console.log('all wired')"
```

👀 **Expect** — real vitest output with per-suite counts (⟨12⟩+⟨18⟩, ⟨35⟩, ⟨10⟩ cases actually executing), then `all wired`.

✅ **Verify**
- [ ] All three projects now HAVE a `test` target and their 75 cases execute (non-zero test counts in the runner output, exit code honored).
- [ ] Negative control: `nx run-many -t test` on a project with specs but no target can no longer happen silently — the wiring check above exits 1 if any regresses.

🔗 **Proves:** REQ-010 · CAP-011
📎 **Source:** OBSERVATIONS OBS-2 (BUG-NXTEST-001, proven mechanism); fix = mirror sibling `@nx/vite:test` targets.

#### 5.2 · ⚠️ Sixty components can't blow the host's context

▶️ **Do**
```bash
node docs/plan/agent-final/demo/seed-registry.mjs 60      # bulk-seed 60 components via the store API
mcp component_search '{"query":"rule"}' | wc -c
```

👀 **Expect** — response size ⟨n⟩ chars where n < 20,000; results are capped summaries with a `total` count, never full bodies.

✅ **Verify**
- [ ] Default search/list responses stay bounded with a 60-item registry (the 464,821-char BUG-003 class cannot recur).

🔗 **Proves:** REQ-014 · CAP-004
📎 **Source:** BUG-003 regression (live 46-agent `agent_list` blowout, superseded/agent-mcp-authoring contexts/discovery-tools.md:28-39) — cap value ⟦U1⟧.

#### 5.3 · ⚠️ An unknown prompt type is rejected at the door

▶️ **Do**
```bash
mcp component_define '{"name":"bad-type","type":"vibes","content":"x"}'
```

👀 **Expect** — structured `INVALID_TYPE: vibes` naming the live `prompt_types` vocabulary; nothing written.

✅ **Verify**
- [ ] Error is typed, lists valid types, and `component_read '{"name":"bad-type"}'` → not found.

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** superseded/agent-mcp-authoring contexts/component-define.md:9-19 — ⟦U1⟧.

#### 5.4 · ⚠️ The host surface never moved

▶️ **Do**
```bash
mcp guide '{}' | diff /tmp/agent-final-demo/tools-before.txt - && echo SURFACE-STABLE
```

👀 **Expect**
```
SURFACE-STABLE
```

✅ **Verify**
- [ ] After every act — authoring, compiling, running, dispatching, deleting — the host's tool listing is byte-identical to the §2.4 capture.

🔗 **Proves:** REQ-007 · CAP-010
📎 **Source:** GOAL.md end-state #7 (host byte-stable); `server.ts` thin-router claim verified (OBSERVATIONS OBS-12).

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
rm -f tmp/agent-mcp/agent-final-demo.db*
rm -rf /tmp/agent-final-demo
git status --porcelain docs/plan/agent-final/superseded/dispatch-completion/demo/fixtures/sample-plan.dag.json
```

👀 **Expect** — both paths gone; `git status` line for the committed fixture is empty (the demo copied, never mutated, it).

✅ **Verify**
- [ ] No demo database or `-wal`/`-shm` residue under `tmp/`; no `/tmp/agent-final-demo`.
- [ ] The committed dispatch fixture is unmodified.

🔗 **Proves:** REQ-015 · CAP-010
📎 **Source:** AGENTS.md §10 "Test/ephemeral artifacts — one central, always-cleaned location".

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Author agents/components over public MCP surface, zero provider deps | 1.1, 1.2, 1.3, 5.3 | H/E | ☐ |
| REQ-002 | Discovery via published sox packages; zero retrieval code in adhd | 2.1, 2.2 | H | ☐ |
| REQ-003 | Deterministic compile: position order, context conditions, 2 platforms | 1.2, 3.1 | H | ☐ |
| REQ-004 | Cache: HIT on identical inputs, MISS on version drift | 3.2, §4 | H | ☐ |
| REQ-005 | One shared edit changes every consuming agent | §4 | H | ☐ |
| REQ-006 | Real run lifecycle; delete cascades to zero orphans | 4.1, §4 | H/R | ☐ |
| REQ-007 | Host = thin router; 15-tool surface byte-stable | 2.4, 5.4 | H/E | ☐ |
| REQ-008 | Dispatch through the shared client; mirrored dialect deleted | 5.1, 5.2, 5.3 | H | ☐ |
| REQ-009 | Plugins load by name; budget cap fires | 4.2 | E | ☐ |
| REQ-010 | Every project with specs has a runnable test target; 75 cases execute | 5.1(sweep) | E | ☐ |
| REQ-011 | Nested gate: store-move demo PASS | §4 | H/E/R | ☐ |
| REQ-012 | Nested gate: dispatch-completion demo PASS | 5.3 | H/E/R | ☐ |
| REQ-013 | Flat `agent_create` compat unchanged | 1.4 | H/E | ☐ |
| REQ-014 | Discovery output bounded (BUG-003 class) | 5.2(sweep) | E | ☐ |
| REQ-015 | Teardown leaves zero residue | §6 | H | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Define/version a component (idempotent, typed) | 1.1, §4, 5.3(sweep) | ☐ |
| CAP-002 | Compose an agent declaratively (transactional) | 1.2, 1.3 | ☐ |
| CAP-003 | Hybrid component search (sox-backed) | 2.1, 2.2 | ☐ |
| CAP-004 | Bounded vocabulary browsing | 5.2(sweep) | ☐ |
| CAP-005 | Compile with cache + platform dispatch | 3.1, 3.2, §4 | ☐ |
| CAP-006 | Run a task through the real orchestrator | 4.1 | ☐ |
| CAP-007 | Delete with active-session guard + cascade | §4 | ☐ |
| CAP-008 | Dispatch a wave through the shared client | 5.1, 5.2, 5.3, §4 | ☐ |
| CAP-009 | Runtime plugin by name (budget) | 4.2 | ☐ |
| CAP-010 | Stable 15-tool host surface | 2.4, 5.4(sweep), §6 | ☐ |
| CAP-011 | Test-integrity gate | 5.1(sweep) | ☐ |
| CAP-012 | Legacy compat shim | 1.4 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

- **6 unresolved interface stubs (⟦U1⟧–⟦U6⟧)** — full ledger in [`UNRESOLVED.md`](./UNRESOLVED.md). Highest impact first: **⟦U6⟧** (the in-process runner/client seam — Act 5 and the climax's dispatch leg hang on it), **⟦U1⟧/⟦U2⟧** (the authoring/discovery tool shapes — the entire authoring lane is designed-but-unbuilt), **⟦U3⟧** (sox publish + Option-A `'generic'` contract — in flight, a landed precondition before Act 2 can run), **⟦U4⟧** (compile tool + cache response fields), **⟦U5⟧** (budget plugin config keys).
- **Scope gaps:** policy/enforcement deliberately absent (owner ruling O-1 — no beat asserts gating); the two nested demos carry their own ⟦U#⟧ ledgers (15 items in dispatch-completion, 5 in store-move) which remain their milestones' acceptance frames — this spine does not re-litigate them.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in
> §7 is proven. One unchecked binary assertion = FAIL until resolved.
