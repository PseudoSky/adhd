# ADR-0008 — Standardized, portable native tooling for dispatched agents (fs / shell / dispatch)

**Status:** PROPOSED (drafted 2026-10-05; revised 2026-10-05 against the owner's written answers and re-presented for reconfirmation) — **AWAITING OWNER APPROVAL. DO NOT treat as accepted.**
This is a decision record drafted for review (FEAT-AGENTMCP-NATIVE-TOOLING / NAT-TOOL-10 is explicit: "DRAFT ONLY, OWNER APPROVAL required; the executor must NOT write/finalize the ADR autonomously"). It authorizes no implementation until the owner approves it, and the upstream-server adoption (D7) additionally waits on the separate human-gated approval NAT-TOOL-8 requires.
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** the umbrella `532e44a4-e9c7-41c0-adda-b2823542f832` (FEAT-AGENTMCP-NATIVE-TOOLING) and its ten children — NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (the human-gated adoption decision), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`. It settles the first-class `AgentDefinition.nativeTooling` contract, the core resolver package, the permission posture, the `ask`-resolution / escalation policy, and the session-retention meaning of `ephemeral`.
**Grounding:** owner directive 2026-10-04 ("Draft ADR-0008 for my review first"); the owner's written answers + clarifications 2026-10-05 (Q1–Q6, reproduced under References); the filed arch-spec bodies of the umbrella and NAT-TOOL-1…10 (`adhd-backlog get`, read 2026-10-05); the research corpus in memory topic `agent-mcp-native-tooling` — build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`, landscape-gap `01M46B0XHMAWV5WBW8J40KAZJC`, tumf shell server `01M46AZC9ZCX11RVKE1C6PQENX`, injection seam `01M46B0SCSSVCJ4N55WB610DR5`; existing repo seams `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers` / `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `entrypoint/dispatch-cli/src/lib/core.ts` (`buildProductionAgentMcpRunner`), `tools/mcp-shell/server.mjs`.

<!-- ADRs are settled decisions, not proposals. This one is deliberately PROPOSED and is not binding
     until the owner approves it. Every cross-repo ADR reference is repo-qualified: `sox ADR-NNNN`
     or `adhd ADR-NNNN` — never a bare `ADR-NNNN` (see README.md). -->

## TL;DR for the next agent

**Every dispatched agent will inherit a standardized native toolset — filesystem, shell, and the agent-mcp "dispatch self" server — described by one typed field, `AgentDefinition.nativeTooling`, and produced by one core resolver, `@adhd/agent-core-native-tooling`.** The field is **portable**: it is resolved at **task time** against the dispatching cwd, never baked in at definition-creation time, so the same stored definition fired from `/P/a` and then `/P/b` yields fs root `/P/a` then `/P/b` while the stored JSON stays byte-identical. The `dispatch` member is **agent-mcp's own MCP server** (the real `task`/`agent` dispatch surface), surfaced so a dispatched agent can dispatch sub-agents — it references the real server, never a bespoke wrapper.

Three traps to avoid:
1. **Resolution is task-time, and the stored definition is never mutated.** If you resolve once and persist the resolved `mcpServers`, you have destroyed portability and broken NAT-TOOL-4/5.
2. **`ask` is not "deny for ephemeral".** `ask` resolves through a typed, ordered policy — **suspend → escalate-to-parent → deny** — and `ephemeral` is a **session-retention/GC** property, not an interactivity or HITL property. An `ask` with neither a live session nor a parent must **deny**, not hang and not silently allow. Base tools default to `allow` with explicit `deny` guardrails precisely so the default toolset is usable.
3. **Adopt, never author, the upstream fs/shell servers — and never conflate their model with ours.** The fs/shell servers are third-party dependencies (D7); the only thing adhd builds is the thin resolver/config adapter. `tumf/mcp-shell-server` gives allowlisted argv execution + audit logging — **not** an opencode-style `allow | ask | deny` layer; that layer is agent-mcp's own (D5). `tools/mcp-shell/server.mjs` is retired by D7.

Until the owner approves this record, **all of the above is inert**. One permission-resolution semantics question (D5) remains explicitly unratified.

## Context

**Dispatched agents ship without a base toolset.** `entrypoint/agent-mcp` is the MCP host and `entrypoint/dispatch-cli` launches sub-agent sessions, but the default `mcpServers` map an agent receives is thin and directory-blind: `buildDefaultMcpServers` / `withDefaultMcpServers` (`entrypoint/agent-mcp/src/defaults.ts`) intended to merge defaults, and the spec records that `withDefaultMcpServers` currently **no-ops** where it should merge (NAT-TOOL-4). The injection seam itself already exists — `dispatch-cli`'s `defaultDispatchMcpServers()` builds a base map and `resolveBacklogMcpEntry()` resolves the backlog entry package-relative (research `01M46B0SCSSVCJ4N55WB610DR5`) — so this work **extends an existing seam** rather than inventing one.

**The consequence is a portability failure.** A file-read or shell call that an agent makes has no guaranteed map to the dispatching directory. `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts` does not yet thread a per-server cwd into the spawned child, and the fs server's own cwd is the only scope it has. The fix must be first-class, because the state that decides the workspace root — the dispatching directory and env — is known only at dispatch.

**Four structural facts from the research shape the design (memory topic `agent-mcp-native-tooling`):**
1. **No first-party MCP shell server exists.** `modelcontextprotocol/servers` ships filesystem, fetch, git, memory, time, and more, but no shell server, and no `@modelcontextprotocol/server-shell` exists. `fs:true` has a reference target; `shell:true` does not — the best-fitting third-party server is `tumf/mcp-shell-server` (allowlisted argv + audit; `01M46AZC9ZCX11RVKE1C6PQENX`).
2. **No MCP server implements a first-class HITL primitive.** Approval is always the client's job. Therefore agent-mcp must **own** the permission layer, mirroring opencode / Claude Code / Codex. The adopted shell server's own model (an argv allowlist plus audit) is **not** that layer.
3. **An `ask` must always resolve to an action, and the safe action fails closed.** The resolution is a typed policy — suspend (if a live session), else escalate to the parent agent, else deny (Context fact 3; `01M46B0XHMAWV5WBW8J40KAZJC`; `01M46AWJ156GH74FY3K6G59M8M`). `ephemeral` does not enter this decision: it is a retention property (D6).
4. **A dispatched agent may itself dispatch.** The `dispatch` member surfaces agent-mcp's own MCP server so a sub-agent can call the real `task`/`agent` surface; it is the same server/config the host already launches, not a re-authored surface.

**Per-server cwd and env are first-class in the MCP SDK transport** (`StdioServerParameters.cwd?` / `env`), so no wrapper is needed to scope a server to the agent's project directory (research `01M46B0S…`; verified against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts`, 2026-10-05). One test constraint is recorded and binding: any e2e that spawns agent-mcp must pass an **isolated cwd** — agent-mcp's `loadEnvHierarchy` loads `<cwd>/.env` with `override:true` and will clobber pinned env vars otherwise.

**What is NOT established, stated plainly.** (a) The concrete third-party server adoption in D7 is **not yet approved** — NAT-TOOL-8 is explicitly a human-gated decision item, its **named human owner is supplied by the owner** (left blank here), and the first-cut vs deferred set still needs the owner's confirmation. (b) The **permission rule-resolution semantics are contradictory across the children** — NAT-TOOL-2 specifies **last-match-wins** (its AC3 depends on it) while NAT-TOOL-6 specifies **most-restrictive-wins** (its AC4 depends on it); the two acceptance criteria cannot both hold for one `matchPermission` implementation. D5 records the recommended posture and carries the conflict as an explicit owner ratification item. (c) This ADR's grounding is the umbrella/children (authoritative) plus the memory research; the memory recall returned a subset of the topic's episodes, and the specific ADR-0008 artifacts (package name, the exact value union) are set by the **umbrella spec**, not the research.

## Decision

### D1 — A standardized native toolset is a first-class default for dispatched agents

Every dispatched agent is resolved to a base native toolset covering **filesystem (`fs`)**, **shell (`shell`)**, and **dispatch self (`dispatch`)**. The default posture is enabled for `fs` and `shell` and present for `dispatch`. This is a default, not a mandate: any of the three may be disabled or replaced per agent (D3).

Merge precedence, highest first, is **explicit `mcpServers` > `nativeTooling` > `dispatch` self**. An agent's explicitly configured `mcpServers` always win; `nativeTooling` supplies the rest; the dispatch self-server is the floor. `withDefaultMcpServers` MUST **merge** (currently it no-ops — `entrypoint/agent-mcp/src/defaults.ts`); the fix is at that source (`adhd ADR-0002`), never a per-caller workaround.

**The `dispatch` member is agent-mcp's own MCP server.** It surfaces the real agent-mcp dispatch surface — the `task` / `agent` (and session) tools the host already exposes — to a dispatched agent, so that agent can dispatch sub-agents. The resolver MUST reference the **real agent-mcp MCP surface** (the same server entry / launch config the host loads), with the tool names the host actually registers. Authoring a weak/non-conformant wrapper — a bespoke mini-server, a renamed surface, or a hand-rolled shim — is **REJECTED**: it diverges from the surface consumers load and silently skips host wiring, dist resolution, and tool registration. `dispatch: true` means the standardized zero-override builtin that points at the real agent-mcp server.

### D2 — A core resolver package: `@adhd/agent-core-native-tooling`

A new **CORE**-tier package owns resolution and permission matching. It is scaffolded with the mandated generator (bare name `native-tooling`, group `agent`, `nxLayer logic`, `platform node`) into `packages/agent/agent-core-native-tooling`, and it publishes **CommonJS-only** (`adhd ADR-0003`).

Public surface:

- `resolveNativeTooling(cfg, { cwd, env, dispatchSelf }) -> McpServerConfig[]`
- `matchPermission(ruleMap, resource) -> PermissionAction`
- `segmentShellCommand(cmd)` — command segmentation for permission matching
- the **server catalog** (the fs/shell/dispatch server specs; the `dispatch` spec resolves to the real agent-mcp server, D1)

CORE, not a plugin: resolution is required by the host (`entrypoint/agent-mcp`) and the dispatch host (`entrypoint/dispatch-cli`), and is a primitive both depend on, not an optional extension (umbrella spec "Decision"). The `ask`-**resolution** policy (D6) is evaluated by the engine/host, which alone holds the session/parent graph; the core package exposes the permission *matching*, not the escalation routing.

### D3 — Typed `nativeTooling` config: `{ fs?, shell?, dispatch?, askPolicy? }`

`packages/agent/agent-base-types` gains:

```
AgentDefinition.nativeTooling?: NativeToolingConfig
NativeToolingConfig = {
  fs?:        FsToolConfig;
  shell?:     ShellToolConfig;
  dispatch?:  DispatchToolConfig;
  askPolicy?: AskPolicy;          // D6
}

FsToolConfig        = boolean | BuiltinFsOptionOverrides       | CustomMcpServerConfig
ShellToolConfig     = boolean | BuiltinShellOptionOverrides    | CustomMcpServerConfig
DispatchToolConfig  = boolean | BuiltinDispatchOptionOverrides | CustomMcpServerConfig
```

Each member means exactly one thing:

- **`false`** — the builtin for that tool is **not** resolved (no server emitted).
- **`true`** — the **standardized zero-override builtin** is resolved (the "zero-override case" of `BuiltinOptionOverrides`). `true` is an accepted **alias** and is **canonicalized internally to the override object** so the rest of the system deals with one representation. For `dispatch`, the builtin is the real agent-mcp server (D1).
- **`BuiltinOptionOverrides`** — resolve the standardized builtin, with the given overrides (e.g. `fs.root`, `shell.permissions`).
- **`CustomMcpServerConfig`** — a full `McpServerConfig` **replaces** the builtin for that tool.

The union is deliberately `boolean | …` (not `… | false`): `true` and `false` are both values, which keeps NAT-TOOL-1's `{fs:true,shell:true,dispatch:true}` ACs and its `boolean` typing intact while the canonical internal form is the override object. Zod validates the union so `{fs:{root:42}}` is rejected at the boundary (`agent-base-types/src/index.ts`, plus orchestrator-side validation where the definition is consumed, `packages/agent/agent-engine-orchestrator/src/interfaces.ts`). A definition with no server `cwd` still validates. The whole `nativeTooling` object survives a serialize → store → read round-trip.

### D4 — Resolution is at TASK time, against the dispatching cwd; the stored definition is immutable

agent-mcp resolves native tooling at **task time**, not definition-creation time. `resolveNativeTooling(def.nativeTooling, { cwd: runtimeCwd, dispatchSelf })` runs when the task fires, where `runtimeCwd` is the dispatching host's cwd. **The stored definition is never mutated by resolution.**

This is the portability guarantee: the same stored agent definition fired from `/P/a` then `/P/b` yields fs root `/P/a` then `/P/b`, while the stored JSON is **byte-identical**. A reused agent gets the **current** cwd on each fire, not the cwd it was first created with. The dispatch host (`entrypoint/dispatch-cli/src/lib/core.ts`, `buildProductionAgentMcpRunner`) sets `cwd = process.cwd()` and threads `nativeTooling`/cwd through **both** the ensure and reuse paths, so a pre-existing agent is **re-asserted** with the current cwd on reuse; `--tools-root` stays consistent with the resolved fs/shell roots.

### D5 — opencode-style permission gating is agent-mcp's own: `allow | ask | deny`, evaluated host-side before `pre:tool_call`

The resolved permission map is evaluated **host-side**, before the `pre:tool_call` hook, for every native tool call. Actions are `'allow' | 'ask' | 'deny'`; a rule maps a resource pattern to an action; wildcards (`*` any chars, `?` one char) and parsed-shell-command matching (compound commands split on `;`, `&&`, `|`, each segment evaluated) mirror opencode's schema. The model is **modelled on** opencode, not imported: opencode's permission engine is not published (`01M46AWJ156GH74FY3K6G59M8M`).

**This layer is agent-mcp's own (D5); the adopted upstream servers are not it.** In particular `tumf/mcp-shell-server` (D7) provides **allowlisted argv execution + audit logging** — it does **not** provide an opencode-style `allow | ask | deny` model. The adopted server is chosen for **safe execution** (argv arrays, never a shell string), not for its permission model. The permission decision, and the `ask` resolution below, are made by agent-mcp.

- **`deny`** → a typed refusal is returned to the caller and the tool is **not executed**.
- **`ask`** → resolved by the ask-resolution policy (D6): suspend, escalate-to-parent, or deny.
- **Defaults:** base tools `allow`; destructive patterns `deny`. This is deliberate — the default toolset must be usable without an interactive answer.

**Rule-resolution semantics are the one unratified decision in this ADR.** The children conflict:

- **NAT-TOOL-2** specifies `matchPermission` as **LAST-MATCH-WINS** (`matchPermission({'*':'ask','git *':'allow','rm *':'deny'},'git status')==='allow'`), which is opencode's own semantics (`01M46AWJ…`).
- **NAT-TOOL-6** specifies **most-restrictive-wins** (`deny > ask > allow`), derived from Claude Code and Codex's two-axis policy.

For resource `'git status'` the overlapping rules are `'*'→ask` and `'git *'→allow`; last-match-wins yields `allow`, most-restrictive yields `ask`. **The two ACs cannot both pass against one implementation.** **Recommended posture for owner ratification: last-match-wins** (faithful to "opencode-style", and required by NAT-TOOL-2) **with an added invariant that `deny` is terminal** (once any `deny` matches, the result is `deny` regardless of later rules) — this preserves opencode's ordered-rule ergonomics while keeping the deny guardrail absolute.

**Re-posed now that `dispatch` is agent-mcp's own server (D1).** The semantics govern whether a dispatched agent can invoke `agent-mcp`'s `task`/`agent` tools. Under last-match-wins an ordered map can allow dispatch explicitly while a broad wildcard denies the rest (`{'*':'deny','agent-mcp.*':'allow'}` → dispatch allowed); under most-restrictive-wins a broad `{'*':'ask'}` forces `ask` on dispatch even if a later `'agent-mcp.*':'allow'` exists. This makes the choice observable through the dispatch surface, not just through shell commands — so the owner's decision is load-bearing for sub-agent fan-out. If the owner chooses pure most-restrictive-wins, NAT-TOOL-2 AC3 and its `matchPermission` contract must be rewritten; either way the two children must be reconciled before implementation.

### D6 — `ask` resolution: suspend / escalate-to-parent / deny; `ephemeral` is a session-retention policy

`ask` is not a terminal state. When a rule resolves to `ask`, the **ask-resolution policy** decides what happens, as an **ordered fallback chain** over three resolutions:

- **`suspend`** — the session suspends and later resumes (sessioned HITL); the user's decision, when "always", is recorded as a typed rule. Applicable when the task has a live interactive session.
- **`escalate`** — the ask is routed to the **parent agent for approval** (parent-approves-HITL). A dispatched sub-agent's `ask` is surfaced to the agent that dispatched it; that parent may itself be interactive (approve directly), may escalate further up the parent chain, or may itself be subject to this same policy. Escalation follows the existing parent/child graph and is **bounded** (v1: by the parent-chain depth), terminating at the root; a root with no live session falls through to `deny`.
- **`deny`** — the request is refused with a typed error (`permission_ask_denied`); the tool is not executed. This is the **fail-closed floor**: if neither `suspend` nor `escalate` is applicable, the result is `deny` — never a hang and never an implicit allow.

The policy is typed config — `nativeTooling.askPolicy` — defaulting to the chain `['suspend', 'escalate', 'deny']`. It is typed config, **not** an env feature switch (`adhd ADR-0001`; `sox ADR-0013`).

```
type AskResolution = 'suspend' | 'escalate' | 'deny';

interface AskPolicy {
  order: AskResolution[];   // default ['suspend', 'escalate', 'deny']; first applicable wins
  escalateTo: 'parent';     // v1: the only escalation target
}
```

**`ephemeral` is a session-retention / GC policy, not an interactivity or HITL property.** A session **may be stored** whether or not it is ephemeral. `ephemeral` governs **reclamation** — whether and when a completed session is garbage-collected — and says nothing about whether the session can answer an `ask`. Interactivity is determined by the presence of a **live session** (for `suspend`) or a **parent** (for `escalate`), never by ephemerality. A session can therefore be ephemeral *and* interactive, or retained *and* non-interactive. The former `nativeTooling.ephemeralAskPolicy` field is replaced by `askPolicy`; session retention is a session/run property (`SessionRetentionPolicy` — `ephemeral?: boolean`, optional TTL), not a native-tooling field.

### D7 — Adopt upstream MCP servers; never author new ones (human-gated)

adhd **adopts** third-party MCP servers and authors only the thin resolver/config adapter (D2). The catalog:

| role | server | status |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | **adopt** — first cut |
| shell | `tumf/mcp-shell-server` (MIT; allowlisted argv array, never a shell string; audit logs) | **adopt** — first cut |
| command segmentation | `unbash` (ISC, 0-dep) | **adopt** — first cut |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) — wraps **both** servers | **deferred** |
| read-only-roots alternative | `rust-mcp-filesystem` (read-only by default) | **deferred** |

**The adopted shell server is not the permission layer.** `tumf/mcp-shell-server` gives **allowlisted argv + audit**, **not** opencode-style `allow | ask | deny`. The opencode-style layer wrapping all tool calls is agent-mcp's own (D5). The server is adopted for **safe execution** — command names as argv arrays, never a shell string, with timeout/output caps and an env allowlist — not for its permission model.

**This is a HUMAN-GATED decision (NAT-TOOL-8).** No dependency may be added and `tools/mcp-shell/server.mjs` may not be removed until the human approval is recorded with a **named owner in all three of `README.md`, `AGENTS.md`, and the gated test header** (per the repo's live-testing/gating rule), and license + maintenance status is written to memory. **The named human-approval owner is intentionally left blank in this record for the owner to supply.** The authored shell server is retired — removed, or explicitly documented as a fallback. No bash-string ever reaches a shell: shell execution is allowlisted command **names as argv arrays**.

### D8 — Portable agent definitions

`AgentDefinition.nativeTooling?` is part of the portable, persisted definition. Because resolution is task-time (D4), the **definition carries no resolved root**; it carries only the declarative config (D3). This is what makes one stored definition usable from any directory. A definition written before this ADR (no `nativeTooling`) still validates and behaves as if the standardized defaults applied.

### D9 — cwd/env propagate to every spawned MCP child

`McpServerConfig.cwd` is threaded through the engine's MCP client layer (`packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `registry.ts`) into the spawned stdio child's working directory; `subprocessEnv()` reaches the child; a server spawned via the `claudecli` provider (`providers/claudecli.ts`) inherits the configured cwd. A server with **no** `cwd` still inherits the parent process cwd (unchanged behavior).

### D10 — Config surface is typed-only in `@adhd/environment`

`packages/environment/environment-base-spec` gains `FieldSpec`s for `nativeTooling.fs.*`, `nativeTooling.shell.*`, `nativeTooling.dispatch.*`, and `nativeTooling.askPolicy`, with the normal code → system → global → project → env cascade. Session retention (`ephemeral`, optional TTL) is a session/run config surface, not a native-tooling field. **No env feature toggles** (`adhd ADR-0001`; `sox ADR-0013`). The legacy `ADHD_AGENT_SHELL_MCP_PATH` migrates onto the typed surface (it is a path *value*, legitimate environment configuration, not a feature switch).

### D11 — The acceptance gate is a real dispatched agent, with an expanded negative-control set

The feature is proven through **real components**, never a unit test of internals (NAT-TOOL-9, per the repo verification standard). A real dispatched agent from `/P` with `{fs:true, shell:true, dispatch:true}` reads `/P/<file>` and runs a shell command in `/P`; the same definition fired `/P` then `/Q` gets each own root with byte-identical stored JSON; a sessioned `ask` suspends+resumes; a sub-agent `ask` escalates to the parent and the parent approves; an ephemeral session is retained or reclaimed according to its retention policy. The e2e spawns agent-mcp with an **isolated cwd + fake HOME** (the `.env override:true` leak).

**Negative controls (each a deliberate revert / wrong-variant that MUST turn the suite RED):**

1. Revert the NAT-TOOL-4 merge (`withDefaultMcpServers` back to a no-op) → a dispatched agent loses the default servers → RED.
2. Revert the NAT-TOOL-3 cwd propagation → fs/shell roots fall back to the parent cwd → RED.
3. Revert task-time resolution to definition-time (persist the resolved servers) → a `/Q` fire leaks the `/P` root → RED.
4. Thread cwd on the ensure path only (drop it on the reuse path) → a reused agent keeps its first cwd → RED.
5. Disable host-side permission evaluation (move it after `pre:tool_call`, or remove it) → a `deny`-matched command executes → RED.
6. Flip the ratified rule-resolution semantics to the rejected variant → the semantics AC flips → RED (exact assertion fixed once the owner ratifies D5).
7. Point `dispatch` at a stub / weak wrapper instead of the real agent-mcp MCP surface → a real sub-dispatch (`task`/`agent`) from a dispatched agent fails → RED.
8. Revert parent-escalation routing → a sub-agent `ask` no longer reaches the parent (hangs or auto-denies) → RED.
9. Make an unanswerable `ask` default to `allow` (fail-open) → the fail-closed assertion → RED.
10. Treat `ephemeral` as non-interactive again (drop/never store the session) → the retention/GC assertion → RED.
11. Remove the isolated cwd + fake HOME from the e2e → `.env override:true` clobbers a pinned env var → RED.

### D12 — This ADR is a draft; implementation is gated behind owner approval

No code in the umbrella/children may be written as "done" against this record until the owner approves it. NAT-TOOL-8's dependency adoption carries its own separate human gate (D7) in addition to this record's approval.

## Consequences

- **Portability becomes a property of the resolver, not of the stored definition.** The same definition is directory-independent; a future caller must not persist resolved `mcpServers` back onto a definition or it silently reintroduces the definition-time-root bug D4 exists to remove.
- **One choke point owns the toolset.** `resolveNativeTooling` + the server catalog are the single place a new base tool is added; two hosts (`agent-mcp`, `dispatch-cli`) consume the same primitive.
- **The `dispatch` surface is the real host surface, not a copy.** Because a dispatched agent can dispatch, any drift between the wrapper and the host would be invisible until real use; D1 forbids a wrapper and D11 control 7 proves the real surface is reached.
- **`ask` always resolves and fails closed.** `deny` is the floor when neither a live session nor a parent can answer; the default-`allow`-with-`deny`-guardrails posture keeps the base toolset usable while an unanswered `ask` cannot hang or silently allow.
- **Escalation is recursive and must be bounded.** Parent-approves-HITL follows the parent chain and terminates at the root; an unbounded chain would allow an unbounded wait, so the policy carries an explicit bound.
- **`ephemeral` no longer implies non-interactive.** Any code or doc that equates ephemeral with "cannot answer an `ask`" is stale and must be corrected; retention/GC and interactivity are orthogonal.
- **The permission layer is ours; the adopted server is not it.** `tumf/mcp-shell-server`'s argv allowlist + audit is execution safety, not `allow | ask | deny`; expecting the server to enforce the permission model would leave the guardrail absent.
- **A new public package and new public types are a semantic-version concern** for `@adhd/agent-core-native-tooling` and `agent-base-types` (additive; D3 adds optional fields).
- **The upstream dependency set is a supply-chain surface.** Adoption (D7) is gated precisely because it adds third-party code; the fs server's per-root read-only is Docker-only, and the shell server is explicitly **not** a sandbox — hence `srt` is held in reserve (deferred first cut).
- **Carried obligation — reconcile the permission semantics.** D5's last-match-wins vs most-restrictive-wins conflict must be resolved and both NAT-TOOL-2 and NAT-TOOL-6 ACs aligned before either executes. It is not silently decided by this draft. See "Backlog reconciliation".

## Alternatives considered

- **Author a first-party fs/shell MCP server.** **REJECTED.** A first-party shell server would duplicate `tumf/mcp-shell-server`'s allowlist/audit/hardening, and a first-party fs server would duplicate the reference server. The research's whole build-vs-integrate verdict is "integrate the servers; build only the thin adapter" (`01M46AWJ156GH74FY3K6G59M8M`).
- **Author a wrapper for the `dispatch` surface.** **REJECTED.** It diverges from the real agent-mcp MCP surface consumers load and skips host wiring / dist resolution / tool registration; D1 requires pointing at the real server.
- **Adopt `tumf/mcp-shell-server` for its permission model.** **REJECTED as a rationale.** It ships allowlisted argv + audit, not `allow | ask | deny`; the permission layer is agent-mcp's own (D5). The server is adopted for safe execution only.
- **Resolve the toolset once, at definition-creation time, and persist the resolved servers.** **REJECTED.** It is the exact portability failure this ADR removes: the stored definition would pin the root it was created in, so firing from `/Q` would leak `/P`. NAT-TOOL-4's negative control (reverting to definition-time resolution) turns the portability test RED.
- **`ephemeral` = non-interactive / no-HITL.** **REJECTED.** `ephemeral` is a session-retention / GC property; a session may be stored whether or not it is ephemeral, and interactivity is decided by a live session or a parent, not by ephemerality. Equating the two made an unanswerable `ask` a functional dead end.
- **`ask` = deny whenever the task cannot suspend.** **SUPERSEDED.** Parent-approves-HITL is now a first-class resolution ahead of deny; deny remains the fail-closed floor only when no live session and no parent can answer.
- **Import opencode's permission engine.** **REJECTED.** It is not published standalone (`01M46AWJ…`); only the *design* is integrated and replicated.
- **`ask` as the default for base tools.** **REJECTED.** The default toolset would fail on first use; default-`allow`-with-`deny`-guardrails is the recorded answer (Context fact 3).
- **`@wonderwhy-er/desktop-commander` as the shell server.** **REJECTED.** Blocked by the research verdict for blocklist + CVE (`01M46AWJ…`).
- **Most-restrictive-wins vs last-match-wins chosen silently.** **NOT DECIDED HERE.** Both are in the children with conflicting ACs; D5 recommends last-match-wins-with-terminal-deny and carries the conflict to the owner rather than pretending it is settled.
- **Config via env-var feature toggles.** **REJECTED.** Violates `adhd ADR-0001` / `sox ADR-0013` (D6, D10).

## ADR compliance

- **`adhd ADR-0001` / `sox ADR-0013` — typed config, never env feature toggles.** Every switch in this ADR is a typed config field: `nativeTooling.fs.*`, `nativeTooling.shell.*`, `nativeTooling.dispatch.*`, `nativeTooling.askPolicy`, and the session retention policy. No `*_ENABLED` / `*_NATIVE_TOOLING` feature switch is introduced; NAT-TOOL-7's gate is an explicit "prove NO new feature-switch env var exists". `ADHD_AGENT_SHELL_MCP_PATH` migrates to the typed surface. (This ADR adds no store, so `adhd ADR-0001`'s sox-store-adapter/multiprocess mandate is not engaged.)
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

## Backlog reconciliation — NAT-TOOL children

The owner's answers change several child ACs. The deltas are named precisely here; none is applied silently. Items not listed are unchanged.

- **NAT-TOOL-1 `65d3ffa3` — no change required.** Its `FsToolConfig = boolean | FsBuiltinOverrides | McpServerConfig` (and the same for `shell`/`dispatch`) already admits `true`; D3 now adopts `true` as the zero-override builtin and canonicalizes it. NAT-TOOL-1 AC1 (`{fs:true,shell:{permissions:{'rm *':'deny'}}}`) stands.
- **NAT-TOOL-2 `efd234d7` — blocked, not edited (unratified).** AC3 encodes **last-match-wins**; it cannot be finalized until the owner ratifies D5's semantics. If the owner chooses most-restrictive-wins, AC3 and the `matchPermission` contract must be rewritten.
- **NAT-TOOL-6 `4c89ef9a` — must be reconciled.** (a) AC3's `ephemeralAskPolicy='allow'` negative-control flip is obsolete: `ephemeral` no longer means non-interactive and `ephemeralAskPolicy` is replaced by `askPolicy`. (b) A new AC is required: a sub-agent `ask` **escalates to the parent agent**, the parent approves, and the tool proceeds. (c) AC4 (most-restrictive-wins) remains in direct conflict with NAT-TOOL-2 AC3 and stays owner-gated.
- **NAT-TOOL-7 `0f624014` — must be reconciled.** The `FieldSpec` list must change from `nativeTooling.ephemeralAskPolicy` to `nativeTooling.askPolicy` (plus `nativeTooling.dispatch.*`); session retention (`ephemeral`/TTL) is a session/run config surface, not a native-tooling field. AC1/AC2 stand; AC3's no-new-env-switch assertion stands.
- **NAT-TOOL-8 `01351dfc` — must be reconciled.** (a) Record that `tumf/mcp-shell-server` provides **allowlisted argv + audit only, not `allow | ask | deny`** — that layer is agent-mcp's own (D5). (b) Confirm the first-cut adopt set (`filesystem` + `tumf/mcp-shell-server` + `unbash`); `srt` and `rust-mcp-filesystem` deferred. (c) AC1's **named human-approval owner is left blank** for the owner to supply.
- **NAT-TOOL-9 `c63fd05c` — must be reconciled.** AC3 must change: "HITL sessioned `ask` suspends+resumes; ephemeral `ask` denies" becomes "sessioned `ask` suspends+resumes; a sub-agent `ask` escalates to the parent; an `ask` with no session and no parent denies". AC4's negative-control set must expand to D11's list.
- **Umbrella `532e44a4` — must be reconciled.** Its Outcome says "HITL accounting is fail-closed for ephemeral tasks"; correct to "`ask` resolution is fail-closed when neither a live session nor a parent can answer" (ephemeral is retention, not interactivity).
- **`cf70080c` (semantics-conflict item) — stays open.** Not edited; NAT-TOOL-2 vs NAT-TOOL-6 semantics remain the owner's call.

**Implied new items (to file once the owner reconfirms):** (1) the ask-resolution / parent-escalation policy (`AskPolicy`, bounded escalation, parent-approves-HITL); (2) the session-retention / GC policy for `ephemeral` (reclamation, TTL). These are carried as proposed children of the umbrella, gated behind the same owner approval.

## Open questions for owner ratification

1. **Permission rule-resolution semantics (D5) — the central remaining question, re-posed with `dispatch` clarified.** NAT-TOOL-2 says **last-match-wins**; NAT-TOOL-6 says **most-restrictive-wins**; their ACs are mutually exclusive, and the choice now also governs whether a dispatched agent may invoke agent-mcp's `task`/`agent` tools. Recommendation: **last-match-wins, with `deny` terminal.** Ratify, or direct pure most-restrictive-wins (and NAT-TOOL-2's contract/AC3 is rewritten).
2. **NAT-TOOL-8 named human-approval owner.** Left blank; the owner supplies the name (required in `README.md` + `AGENTS.md` + the gated test header).
3. **Adopt set confirmation.** Confirm the first cut is **`filesystem` + `tumf/mcp-shell-server` + `unbash`**, with `@anthropic-ai/sandbox-runtime` (`srt`) and `rust-mcp-filesystem` **deferred**.
4. **`askPolicy` default and escalation bounds (D6).** Confirm the default chain `['suspend', 'escalate', 'deny']`, `escalateTo: 'parent'`, and the escalation bound (v1 parent-chain depth).
5. **Session-retention default (D6).** Confirm dispatched sessions default to `ephemeral: true` with reclamation on completion, and confirm the retention TTL surface.
6. **Acceptance-gate negative controls (D11).** Confirm the expanded set of eleven controls is the required RED set.

**Resolved and moved out of this list:** the `true` alias (D3 — kept); the `dispatch` field shape (D1 — agent-mcp's own real server, `dispatch: true` = that server). Both are recorded above rather than re-asked.

## References

- Owner directive, 2026-10-04 — "Draft ADR-0008 for my review first."
- Owner answers + clarifications, 2026-10-05 (Q1–Q6): Q1/Q4 — `dispatch` is agent-mcp's **own** MCP server (the real `task`/`agent` dispatch surface), surfaced to dispatched agents; reference the real surface, never a weak wrapper; re-pose the permission-semantics question. Q2 — keep the `true` alias. Q3 — `tumf/mcp-shell-server` gives allowlisted argv + audit, **not** opencode-style `allow/ask/deny`; the permission layer is agent-mcp's own; confirm the adopt set and leave NAT-TOOL-8's named owner blank. Q5 — `ephemeral` is a session-retention/GC policy (not interactivity), and `ask` gains parent-agent escalation. Q6 — broaden the acceptance gate's negative controls.
- Backlog: umbrella `532e44a4-e9c7-41c0-adda-b2823542f832`; NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (human-gated), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`; semantics-conflict item `cf70080c-5eef-4d1a-9bf3-ffba6ccbe3d6`.
- Memory topic `agent-mcp-native-tooling`: build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`; landscape gap `01M46B0XHMAWV5WBW8J40KAZJC`; `tumf/mcp-shell-server` `01M46AZC9ZCX11RVKE1C6PQENX`; injection seam `01M46B0SCSSVCJ4N55WB610DR5`; stdio per-server cwd `01M462BWBGS4ZNE20F9NJAADSA`.
- Repo seams: `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers`, `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `entrypoint/agent-mcp/src/config.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts`, `entrypoint/dispatch-cli/src/lib/core.ts`, `packages/environment/environment-base-spec/src/index.ts`, `tools/mcp-shell/server.mjs`.
- `adhd ADR-0001` (stores → sox-store adapter; typed config, no env toggles), `adhd ADR-0002` (correct the source), `adhd ADR-0003` (CJS-only), `adhd ADR-0004` (MCP flat payload).
- `sox ADR-0013` — `sox-ecosystem/docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`.
- Upstream: `github.com/modelcontextprotocol/servers/tree/main/src/filesystem`, `github.com/tumf/mcp-shell-server`, `github.com/anthropics/sandbox-runtime`, `webpro-nl/unbash`.
