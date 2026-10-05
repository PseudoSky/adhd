# ADR-0008 — Standardized, portable native tooling for dispatched agents (fs / shell / dispatch)

**Status:** PROPOSED (drafted 2026-10-05) — **AWAITING OWNER APPROVAL. DO NOT treat as accepted.**
This is a decision record drafted for review (FEAT-AGENTMCP-NATIVE-TOOLING / NAT-TOOL-10 is explicit: "DRAFT ONLY, OWNER APPROVAL required; the executor must NOT write/finalize the ADR autonomously"). It authorizes no implementation until the owner approves it, and the upstream-server adoption (D7) additionally waits on the separate human-gated approval NAT-TOOL-8 requires.
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** the umbrella `532e44a4-e9c7-41c0-adda-b2823542f832` (FEAT-AGENTMCP-NATIVE-TOOLING) and its ten children — NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (the human-gated adoption decision), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`. It settles the first-class `AgentDefinition.nativeTooling` contract, the core resolver package, and the permission posture.
**Grounding:** owner directive 2026-10-04 ("Draft ADR-0008 for my review first"); the filed arch-spec bodies of the umbrella and NAT-TOOL-1…10 (`adhd-backlog get`, read 2026-10-05); the research corpus in memory topic `agent-mcp-native-tooling` — build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`, landscape-gap `01M46B0XHMAWV5WBW8J40KAZJC`, tumf shell server `01M46AZC9ZCX11RVKE1C6PQENX`, injection seam `01M46B0SCSSVCJ4N55WB610DR5`; existing repo seams `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers` / `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `entrypoint/dispatch-cli/src/lib/core.ts` (`buildProductionAgentMcpRunner`), `tools/mcp-shell/server.mjs`.

<!-- ADRs are settled decisions, not proposals. This one is deliberately PROPOSED and is not binding
     until the owner approves it. Every cross-repo ADR reference is repo-qualified: `sox ADR-NNNN`
     or `adhd ADR-NNNN` — never a bare `ADR-NNNN` (see README.md). -->

## TL;DR for the next agent

**Every dispatched agent will inherit a standardized native toolset — filesystem, shell, and the agent-mcp "dispatch self" server — described by one typed field, `AgentDefinition.nativeTooling`, and produced by one core resolver, `@adhd/agent-core-native-tooling`.** The field is **portable**: it is resolved at **task time** against the dispatching cwd, never baked in at definition-creation time, so the same stored definition fired from `/P/a` and then `/P/b` yields fs root `/P/a` then `/P/b` while the stored JSON stays byte-identical.

Three traps to avoid:
1. **Resolution is task-time, and the stored definition is never mutated.** If you resolve once and persist the resolved `mcpServers`, you have destroyed portability and broken NAT-TOOL-4/5.
2. **`ask` fails closed.** A non-interactive (ephemeral) dispatched agent cannot answer an `ask`; an unanswered `ask` must **deny**, not hang and not silently allow. Base tools default to `allow` with explicit `deny` guardrails precisely so the default toolset is usable.
3. **Adopt, never author, the upstream servers.** The fs/shell servers are third-party dependencies (D7); the only thing adhd builds is the thin resolver/config adapter. `tools/mcp-shell/server.mjs` is retired by D7.

Until the owner approves this record, **all of the above is inert**. One permission-resolution semantics question (D5) is explicitly unrratified.

## Context

**Dispatched agents ship without a base toolset.** `entrypoint/agent-mcp` is the MCP host and `entrypoint/dispatch-cli` launches sub-agent sessions, but the default `mcpServers` map an agent receives is thin and directory-blind: `buildDefaultMcpServers` / `withDefaultMcpServers` (`entrypoint/agent-mcp/src/defaults.ts`) intended to merge defaults, and the spec records that `withDefaultMcpServers` currently **no-ops** where it should merge (NAT-TOOL-4). The injection seam itself already exists — `dispatch-cli`'s `defaultDispatchMcpServers()` builds a base map and `resolveBacklogMcpEntry()` resolves the backlog entry package-relative (research `01M46B0SCSSVCJ4N55WB610DR5`) — so this work **extends an existing seam** rather than inventing one.

**The consequence is a portability failure.** A file-read or shell call that an agent makes has no guaranteed map to the dispatching directory. `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts` does not yet thread a per-server cwd into the spawned child, and the fs server's own cwd is the only scope it has. The fix must be first-class, because the state that decides the workspace root — the dispatching directory and env — is known only at dispatch.

**Three structural facts from the research shape the design (memory topic `agent-mcp-native-tooling`):**
1. **No first-party MCP shell server exists.** `modelcontextprotocol/servers` ships filesystem, fetch, git, memory, time, and more, but no shell server, and no `@modelcontextprotocol/server-shell` exists. `fs:true` has a reference target; `shell:true` does not — the best-fitting third-party server is `tumf/mcp-shell-server` (allowlisted argv + audit; `01M46AZC9ZCX11RVKE1C6PQENX`).
2. **No MCP server implements a first-class HITL primitive.** Approval is always the client's job. Therefore agent-mcp must **own** the permission layer, mirroring opencode / Claude Code / Codex.
3. **An `ask` a non-interactive sub-agent cannot answer is a functional failure.** The recorded design answer is: base tools default to `allow` with explicit `deny` guardrails, and an ephemeral `ask` fails closed (`01M46B0XHMAWV5WBW8J40KAZJC`; `01M46AWJ156GH74FY3K6G59M8M`).

**Per-server cwd and env are first-class in the MCP SDK transport** (`StdioServerParameters.cwd?` / `env`), so no wrapper is needed to scope a server to the agent's project directory (research `01M46B0S…`; verified against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts`, 2026-10-05). One test constraint is recorded and binding: any e2e that spawns agent-mcp must pass an **isolated cwd** — agent-mcp's `loadEnvHierarchy` loads `<cwd>/.env` with `override:true` and will clobber pinned env vars otherwise.

**What is NOT established, stated plainly.** (a) The concrete third-party server adoption in D7 is **not yet approved** — NAT-TOOL-8 is explicitly a human-gated decision item, and the shell-server choice was internally inconsistent in the research corpus (`tumf/mcp-shell-server` is the latest, highest-importance verdict; earlier episodes still named `desktop-commander`, which the verdict blocks over blocklist + CVE). (b) The **permission rule-resolution semantics are contradictory across the children** — NAT-TOOL-2 specifies **last-match-wins** (its AC3 depends on it) while NAT-TOOL-6 specifies **most-restrictive-wins** (its AC4 depends on it); the two acceptance criteria cannot both hold for one `matchPermission` implementation. D5 records the recommended posture and the conflict is carried as an explicit owner ratification item. (c) This ADR's grounding is the umbrella/children (authoritative) plus the memory research; the memory recall returned a subset of the topic's episodes, and the specific ADR-0008 artifacts (package name, the exact value union) are set by the **umbrella spec**, not the research.

## Decision

### D1 — A standardized native toolset is a first-class default for dispatched agents

Every dispatched agent is resolved to a base native toolset covering **filesystem (`fs`)**, **shell (`shell`)**, and **dispatch self (`dispatch`)**. The default posture is enabled for `fs` and `shell` and present for `dispatch`. This is a default, not a mandate: any of the three may be disabled or replaced per agent (D3).

Merge precedence, highest first, is **explicit `mcpServers` > `nativeTooling` > `dispatch` self**. An agent's explicitly configured `mcpServers` always win; `nativeTooling` supplies the rest; the dispatch self-server is the floor. `withDefaultMcpServers` MUST **merge** (currently it no-ops — `entrypoint/agent-mcp/src/defaults.ts`); the fix is at that source (`adhd ADR-0002`), never a per-caller workaround.

### D2 — A core resolver package: `@adhd/agent-core-native-tooling`

A new **CORE**-tier package owns resolution and permission matching. It is scaffolded with the mandated generator (bare name `native-tooling`, group `agent`, `nxLayer logic`, `platform node`) into `packages/agent/agent-core-native-tooling`, and it publishes **CommonJS-only** (`adhd ADR-0003`).

Public surface:

- `resolveNativeTooling(cfg, { cwd, env, dispatchSelf }) -> McpServerConfig[]`
- `matchPermission(ruleMap, resource) -> PermissionAction`
- `segmentShellCommand(cmd)` — command segmentation for permission matching
- the **server catalog** (the fs/shell/dispatch server specs)

CORE, not a plugin: resolution is required by the host (`entrypoint/agent-mcp`) and the dispatch host (`entrypoint/dispatch-cli`), and is a primitive both depend on, not an optional extension (umbrella spec "Decision").

### D3 — Typed `nativeTooling` config: `{ fs?, shell?, dispatch? }`, each `BuiltinOptionOverrides | CustomMcpServerConfig | false`

`packages/agent/agent-base-types` gains:

```
AgentDefinition.nativeTooling?: NativeToolingConfig
NativeToolingConfig = { fs?: FsToolConfig; shell?: ShellToolConfig; dispatch?: DispatchToolConfig }

FsToolConfig      = BuiltinFsOptionOverrides | CustomMcpServerConfig | false
ShellToolConfig   = BuiltinShellOptionOverrides | CustomMcpServerConfig | false
DispatchToolConfig = BuiltinDispatchOptionOverrides | CustomMcpServerConfig | false
```

Each member means exactly one thing:

- **`false`** — the builtin for that tool is **not** resolved (no server emitted).
- **`BuiltinOptionOverrides`** — resolve the standardized builtin, with the given overrides (e.g. `fs.root`, `fs.permissions`); the zero-override case is the standardized default.
- **`CustomMcpServerConfig`** — a full `McpServerConfig` **replaces** the builtin for that tool.

The intended distinction is *builtin-with-overrides* vs *whole custom server* vs *off*. Zod validates the union so `{fs:{root:42}}` is rejected at the boundary (`agent-base-types/src/index.ts`, plus orchestrator-side validation where the definition is consumed, `packages/agent/agent-engine-orchestrator/src/interfaces.ts`). A definition with no server `cwd` still validates. The whole `nativeTooling` object survives a serialize → store → read round-trip.

**Open discrepancy carried to the owner (see Open questions):** NAT-TOOL-1 specifies `FsToolConfig = boolean | FsBuiltinOverrides | McpServerConfig` (a `boolean`, so `true` is a value), while this ADR's charter specifies `BuiltinOptionOverrides | CustomMcpServerConfig | false` (no `true`). Recommendation: keep `true` as an **alias for the zero-override builtin** so NAT-TOOL-1's ACs hold, and canonicalize to the override object internally; the owner ratifies or drops the alias.

### D4 — Resolution is at TASK time, against the dispatching cwd; the stored definition is immutable

agent-mcp resolves native tooling at **task time**, not definition-creation time. `resolveNativeTooling(def.nativeTooling, { cwd: runtimeCwd, dispatchSelf })` runs when the task fires, where `runtimeCwd` is the dispatching host's cwd. **The stored definition is never mutated by resolution.**

This is the portability guarantee: the same stored agent definition fired from `/P/a` then `/P/b` yields fs root `/P/a` then `/P/b`, while the stored JSON is **byte-identical**. A reused agent gets the **current** cwd on each fire, not the cwd it was first created with. The dispatch host (`entrypoint/dispatch-cli/src/lib/core.ts`, `buildProductionAgentMcpRunner`) sets `cwd = process.cwd()` and threads `nativeTooling`/cwd through **both** the ensure and reuse paths, so a pre-existing agent is **re-asserted** with the current cwd on reuse; `--tools-root` stays consistent with the resolved fs/shell roots.

### D5 — opencode-style permission gating: `allow | ask | deny`, evaluated host-side before `pre:tool_call`

The resolved permission map is evaluated **host-side**, before the `pre:tool_call` hook, for every native tool call. Actions are `'allow' | 'ask' | 'deny'`; a rule maps a resource pattern to an action; wildcards (`*` any chars, `?` one char) and parsed-shell-command matching (compound commands split on `;`, `&&`, `|`, each segment evaluated) mirror opencode's schema. The model is **modelled on** opencode, not imported: opencode's permission engine is not published (`01M46AWJ156GH74FY3K6G59M8M`).

- **`deny`** → a typed refusal is returned to the caller and the tool is **not executed**.
- **`ask`** → sessioned HITL suspend/resume (D6).
- **Defaults:** base tools `allow`; destructive patterns `deny`. This is deliberate — an unanswerable `ask` on a base tool would make the default toolset unusable for a non-interactive agent (Context fact 3).

**Rule-resolution semantics are the one unrratified decision in this ADR.** The children conflict:

- **NAT-TOOL-2** specifies `matchPermission` as **LAST-MATCH-WINS** (`matchPermission({'*':'ask','git *':'allow','rm *':'deny'},'git status')==='allow'`), which is opencode's own semantics (`01M46AWJ…`).
- **NAT-TOOL-6** specifies **most-restrictive-wins** (`deny > ask > allow`), derived from Claude Code and Codex's two-axis policy.

For resource `'git status'` the overlapping rules are `'*'→ask` and `'git *'→allow`; last-match-wins yields `allow`, most-restrictive yields `ask`. **The two ACs cannot both pass against one implementation.** **Recommended posture for owner ratification: last-match-wins** (faithful to "opencode-style", and required by NAT-TOOL-2) **with an added invariant that `deny` is terminal** (once any `deny` matches, the result is `deny` regardless of later rules) — this preserves opencode's ordered-rule ergonomics while keeping the deny guardrail absolute. If the owner instead chooses pure most-restrictive-wins, NAT-TOOL-2 AC3 and its `matchPermission` contract must be rewritten. Either way the two children must be reconciled before implementation.

### D6 — HITL: sessioned `ask` suspends/resumes; ephemeral `ask` fails closed

- A **sessioned** (interactive) task hitting `ask` **suspends** and later **resumes**; the approval decision is recorded as a typed rule when the user chooses "always".
- An **ephemeral** task (a non-interactive dispatched agent) hitting `ask` is **denied by default**, with typed error `permission_ask_ephemeral` — it never hangs and never silently allows.
- The only way to permit an ephemeral `ask` is a **typed config field** `nativeTooling.ephemeralAskPolicy` whose default is `deny`. This is typed config, **not** an env feature switch (`adhd ADR-0001`; `sox ADR-0013`).

### D7 — Adopt upstream MCP servers; never author new ones (human-gated)

adhd **adopts** third-party MCP servers and authors only the thin resolver/config adapter (D2). The catalog:

| role | server | status |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | proposed — adopt |
| shell | `tumf/mcp-shell-server` (MIT; allowlisted argv array, never a shell string; audit logs) | proposed — adopt |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) — wraps **both** servers | proposed — optional |
| command segmentation | `unbash` (ISC, 0-dep) | proposed — adopt |
| read-only-roots alternative | `rust-mcp-filesystem` (read-only by default) | optional |

**This is a HUMAN-GATED decision (NAT-TOOL-8).** No dependency may be added and `tools/mcp-shell/server.mjs` may not be removed until the human approval is recorded with a **named owner in all three of `README.md`, `AGENTS.md`, and the gated test header** (per the repo's live-testing/gating rule), and license + maintenance status is written to memory. The authored shell server is retired — removed, or explicitly documented as a fallback. No bash-string ever reaches a shell: shell execution is allowlisted command **names as argv arrays**, with timeout/output caps and an env allowlist, matching `tumf/mcp-shell-server`'s model.

### D8 — Portable agent definitions

`AgentDefinition.nativeTooling?` is part of the portable, persisted definition. Because resolution is task-time (D4), the **definition carries no resolved root**; it carries only the declarative config (D3). This is what makes one stored definition usable from any directory. A definition written before this ADR (no `nativeTooling`) still validates and behaves as if the standardized defaults applied.

### D9 — cwd/env propagate to every spawned MCP child

`McpServerConfig.cwd` is threaded through the engine's MCP client layer (`packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `registry.ts`) into the spawned stdio child's working directory; `subprocessEnv()` reaches the child; a server spawned via the `claudecli` provider (`providers/claudecli.ts`) inherits the configured cwd. A server with **no** `cwd` still inherits the parent process cwd (unchanged behavior).

### D10 — Config surface is typed-only in `@adhd/environment`

`packages/environment/environment-base-spec` gains `FieldSpec`s for `nativeTooling.fs.*`, `nativeTooling.shell.*`, and `nativeTooling.ephemeralAskPolicy`, with the normal code → system → global → project → env cascade. **No env feature toggles** (`adhd ADR-0001`; `sox ADR-0013`). The legacy `ADHD_AGENT_SHELL_MCP_PATH` migrates onto the typed surface (it is a path *value*, legitimate environment configuration, not a feature switch).

### D11 — The acceptance gate is a real dispatched agent, with negative controls

The feature is proven through **real components**, never a unit test of internals (NAT-TOOL-9, per the repo verification standard). A real dispatched agent from `/P` with `{fs:true, shell:true, dispatch:true}` reads `/P/<file>` and runs a shell command in `/P`; the same definition fired `/P` then `/Q` gets each own root with byte-identical stored JSON; a sessioned `ask` suspends+resumes and an ephemeral `ask` denies. **Negative controls:** reverting the NAT-TOOL-4 merge turns the test RED; reverting the NAT-TOOL-3 cwd propagation makes the roots fall back and turns the test RED. The e2e spawns agent-mcp with an **isolated cwd + fake HOME** (the `.env override:true` leak).

### D12 — This ADR is a draft; implementation is gated behind owner approval

No code in the umbrella/children may be written as "done" against this record until the owner approves it. NAT-TOOL-8's dependency adoption carries its own separate human gate (D7) in addition to this record's approval.

## Consequences

- **Portability becomes a property of the resolver, not of the stored definition.** The same definition is directory-independent; a future caller must not persist resolved `mcpServers` back onto a definition or it silently reintroduces the definition-time-root bug D4 exists to remove.
- **One choke point owns the toolset.** `resolveNativeTooling` + the server catalog are the single place a new base tool is added; two hosts (`agent-mcp`, `dispatch-cli`) consume the same primitive.
- **The permission layer is adhd's, and its failure mode is explicit.** `ask` on an ephemeral agent is a hard deny with a typed error — never a hang, never an implicit allow. The default-`allow`-with-`deny`-guardrails posture is what keeps the base toolset usable while an unanswered `ask` fails closed.
- **A new public package and new public types are a semantic-version concern** for `@adhd/agent-core-native-tooling` and `agent-base-types` (additive; D3 adds optional fields).
- **The upstream dependency set is a supply-chain surface.** Adoption (D7) is gated precisely because it adds third-party code; the fs server's per-root read-only is Docker-only, and the shell server is explicitly **not** a sandbox — hence `srt` for OS enforcement.
- **Carried obligation — reconcile the permission semantics.** D5's last-match-wins vs most-restrictive-wins conflict must be resolved and both NAT-TOOL-2 and NAT-TOOL-6 ACs aligned before either executes. It is not silently decided by this draft.
- **Carried obligation — the `true` alias.** D3 recommends accepting `true` as the zero-override builtin to preserve NAT-TOOL-1's `boolean` AC; the owner ratifies or the children are corrected.

## Alternatives considered

- **Author a first-party fs/shell MCP server.** **REJECTED.** A first-party shell server would duplicate `tumf/mcp-shell-server`'s allowlist/audit/hardening, and a first-party fs server would duplicate the reference server. The research's whole build-vs-integrate verdict is "integrate the servers; build only the thin adapter" (`01M46AWJ156GH74FY3K6G59M8M`).
- **Resolve the toolset once, at definition-creation time, and persist the resolved servers.** **REJECTED.** It is the exact portability failure this ADR removes: the stored definition would pin the root it was created in, so firing from `/Q` would leak `/P`. NAT-TOOL-4's negative control (reverting to definition-time resolution) turns the portability test RED.
- **Import opencode's permission engine.** **REJECTED.** It is not published standalone (`01M46AWJ…`); only the *design* is integrated and replicated.
- **`ask` as the default for base tools.** **REJECTED.** A non-interactive dispatched agent cannot answer it, so the default toolset would fail on first use. Default-`allow`-with-`deny`-guardrails is the recorded answer (Context fact 3).
- **`@wonderwhy-er/desktop-commander` as the shell server.** **REJECTED.** Blocked by the research verdict for blocklist + CVE (`01M46AWJ…`).
- **Most-restrictive-wins vs last-match-wins chosen silently.** **NOT DECIDED HERE.** Both are in the children with conflicting ACs; D5 recommends last-match-wins-with-terminal-deny and carries the conflict to the owner rather than pretending it is settled.
- **Config via env-var feature toggles.** **REJECTED.** Violates `adhd ADR-0001` / `sox ADR-0013` (D6, D10).

## ADR compliance

- **`adhd ADR-0001` / `sox ADR-0013` — typed config, never env feature toggles.** Every switch in this ADR is a typed config field: `nativeTooling.fs.*`, `nativeTooling.shell.*`, `nativeTooling.ephemeralAskPolicy`. No `*_ENABLED` / `*_NATIVE_TOOLING` feature switch is introduced; NAT-TOOL-7's gate is an explicit "prove NO new feature-switch env var exists". `ADHD_AGENT_SHELL_MCP_PATH` migrates to the typed surface. (This ADR adds no store, so `adhd ADR-0001`'s sox-store-adapter/multiprocess mandate is not engaged.)
- **`adhd ADR-0002` — correct the source, never work around.** The `withDefaultMcpServers` no-op is fixed at its source (`entrypoint/agent-mcp/src/defaults.ts`), not patched per caller; the base toolset is resolved by one core package rather than re-implemented in each host; the cwd propagation is fixed in the engine client, not shimmed per provider.
- **`adhd ADR-0003` — CJS-only.** `@adhd/agent-core-native-tooling` publishes CommonJS-only (`main: ./dist/index.js`, `type` unset, no `module`, no `exports`); its acceptance gate includes `require(dist)` loading without throwing.
- **`adhd ADR-0004` — MCP flat payload.** Unaffected; this ADR does not change any tool's return envelope (`adhd ADR-0006`'s `{ok,data}` outcome envelope remains the tool's own flat return).
- **`adhd ADR-0006` / `adhd ADR-0007` — backlog surface.** Unaffected; this ADR touches no backlog verb.
- **Repo live-testing / gating rule.** NAT-TOOL-8's human gate is documented in all three required places if an approval is recorded; the default-running e2e (D11) is the proof, not a gated suite.

## What does NOT change

- **The existing injection seam.** `dispatch-cli`'s `defaultDispatchMcpServers()` / `resolveBacklogMcpEntry()` and the backlog MCP entry stay; this ADR extends them (research `01M46B0S…`).
- **The backlog and memory servers** an agent already receives — they remain, alongside the native toolset.
- **A server with no `cwd`** still inherits the parent process cwd (D9).
- **The permission model's surface** — `allow | ask | deny` and opencode-style patterns — is adopted, not redesigned; the open question is only the *resolution* rule (D5), not the vocabulary.
- **`adhd ADR-0001`'s store substrate and multiprocess mandate** — not engaged (no store). **`adhd ADR-0002`** is applied, not amended.
- **No dependency is added, and no file is removed, by this record's mere existence** — D7's adoption waits on its own human gate.

## Open questions for owner ratification

1. **Permission rule-resolution semantics (D5) — the central open question.** NAT-TOOL-2 says **last-match-wins**; NAT-TOOL-6 says **most-restrictive-wins**; their ACs are mutually exclusive. Recommendation: **last-match-wins, with `deny` terminal.** Ratify, or direct pure most-restrictive-wins (and NAT-TOOL-2's contract/AC3 is rewritten).
2. **The `true` alias (D3).** The charter's union is `... | false` (no `true`); NAT-TOOL-1 uses `boolean`. Recommendation: accept `true` as the zero-override builtin, canonicalize internally. Keep or drop?
3. **Shell-server adoption (D7).** Confirm `tumf/mcp-shell-server` as the shell server and the human gate's named owner (NAT-TOOL-8), and confirm whether `srt` and `rust-mcp-filesystem` are in the first cut or deferred.
4. **`dispatch` self-server field shape.** Whether `dispatch` is a full `BuiltinDispatchOptionOverrides | CustomMcpServerConfig | false` (this ADR's reading of the charter) or the simpler `boolean | McpServerConfig` of NAT-TOOL-1.
5. **Default `ephemeralAskPolicy`.** Confirm the default is `deny` (fail-closed) with no env override.
6. **Scope of the acceptance gate.** Confirm the two negative controls (revert the NAT-TOOL-4 merge; revert the NAT-TOOL-3 cwd propagation) are the required RED controls.

## References

- Owner directive, 2026-10-04 — "Draft ADR-0008 for my review first."
- Backlog: umbrella `532e44a4-e9c7-41c0-adda-b2823542f832`; NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (human-gated), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`.
- Memory topic `agent-mcp-native-tooling`: build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`; landscape gap `01M46B0XHMAWV5WBW8J40KAZJC`; `tumf/mcp-shell-server` `01M46AZC9ZCX11RVKE1C6PQENX`; injection seam `01M46B0SCSSVCJ4N55WB610DR5`; stdio per-server cwd `01M462BWBGS4ZNE20F9NJAADSA`.
- Repo seams: `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers`, `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `entrypoint/agent-mcp/src/config.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts`, `entrypoint/dispatch-cli/src/lib/core.ts`, `packages/environment/environment-base-spec/src/index.ts`, `tools/mcp-shell/server.mjs`.
- `adhd ADR-0001` (stores → sox-store adapter; typed config, no env toggles), `adhd ADR-0002` (correct the source), `adhd ADR-0003` (CJS-only), `adhd ADR-0004` (MCP flat payload).
- `sox ADR-0013` — `sox-ecosystem/docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`.
- Upstream: `github.com/modelcontextprotocol/servers/tree/main/src/filesystem`, `github.com/tumf/mcp-shell-server`, `github.com/anthropics/sandbox-runtime`, `webpro-nl/unbash`.
