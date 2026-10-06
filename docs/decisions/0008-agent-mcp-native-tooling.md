# ADR-0008 — Standardized, portable native tooling for dispatched agents (fs / shell / dispatch)

**Status:** ACCEPTED (owner-approved 2026-10-05; all six ratification questions resolved — see "Owner ratification (all six RESOLVED)").
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** the umbrella `532e44a4-e9c7-41c0-adda-b2823542f832` (FEAT-AGENTMCP-NATIVE-TOOLING) and its ten children — NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (the human-gated adoption decision), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`. It settles the first-class `AgentDefinition.nativeTooling` contract, the core resolver package, the **thin** permission gate, the `ask`-resolution / escalation policy, the **sessioned-everything** model, and the session-retention meaning of `ephemeral`.
**Grounding:** owner directive 2026-10-04 ("Draft ADR-0008 for my review first"); the owner's written answers 2026-10-05 (Q1–Q6, reproduced under References); the two final reconciliation returns 2026-10-05 — the **product session/retention model** and the **researcher D5 harness-vs-safety verdict** (memory `01M4725749GX9Y6QY10QQ5DH62`, `01M4724WXRDC8DSEVT9N0V7S4Y`, `01M47253250MJNMN15QJ4V21RN`, `01M4724ZFSFWK182N4Y2HPMTTE`); the filed arch-spec bodies of the umbrella and NAT-TOOL-1…10 (`adhd-backlog get`, read 2026-10-05); the research corpus in memory topic `agent-mcp-native-tooling` — build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`, landscape-gap `01M46B0XHMAWV5WBW8J40KAZJC`, tumf shell server `01M46AZC9ZCX11RVKE1C6PQENX`, injection seam `01M46B0SCSSVCJ4N55WB610DR5`; existing repo seams `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers` / `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `entrypoint/dispatch-cli/src/lib/core.ts` (`buildProductionAgentMcpRunner`), `tools/mcp-shell/server.mjs`.

## TL;DR for the next agent

**Every dispatched agent is sessioned and inherits a standardized native toolset — filesystem, shell, and the agent-mcp "dispatch self" server — described by one typed field, `AgentDefinition.nativeTooling`, and produced by one core resolver, `@adhd/agent-core-native-tooling`.** The field is **portable**: it is resolved at **task time** against the dispatching cwd, never baked in at definition-creation time, so the same stored definition fired from `/P/a` and then `/P/b` yields fs root `/P/a` then `/P/b` while the stored JSON stays byte-identical. The `dispatch` member is **agent-mcp's own MCP server** (the real `task`/`agent` dispatch surface), surfaced so a dispatched agent can dispatch sub-agents — it references the real server, never a bespoke wrapper.

Three traps to avoid:

1. **Resolution is task-time, and the stored definition is never mutated.** If you resolve once and persist the resolved `mcpServers`, you have destroyed portability and broken NAT-TOOL-4/5.
2. **Every task is now sessioned, and `ask` is not resolved by session *existence*.** The noop-session path is retired (a one-shot `agent_name` dispatch creates a real session). `ask` resolves through a fixed chain — **suspend (iff `nativeTooling.hitl !== false`) → escalate-to-parent (iff a parent exists, to the root) → deny (the floor)** — and `ephemeral` is a **session-retention CLASS** (`retention: 'ephemeral'|'retained'` + optional `ttlMs`), not an interactivity or HITL property. An unanswered `ask` **denies**, never hangs and never silently allows. `nativeTooling.hitl:false` (legacy `allowHumanInput`) hides `request_human_input` and prunes `suspend`; `askPolicy`/`ephemeralAskPolicy` are retired.
3. **The harness owns the GATE, not the safety — and adopts, never authors, the fs/shell servers.** agent-mcp owns only the generic permission gate (hooks, HITL plumbing, **tool-NAME** allow/ask/deny, server-allowlist passthrough, fail-closed asks). It **must not** own dangerous-command catalogs or shell-command segmentation. Hard enforcement is **delegated** to `@anthropic-ai/sandbox-runtime` (`srt`, wrapping both servers), the shell argv allowlist (`tumf/mcp-shell-server`), and the reference fs server's root scoping. `unbash` is **dropped**; `tools/mcp-shell/server.mjs` is the **removed** thick layer, replaced by the adopted server — never grown.

## Context

**Dispatched agents ship without a base toolset.** `entrypoint/agent-mcp` is the MCP host and `entrypoint/dispatch-cli` launches sub-agent sessions, but the default `mcpServers` map an agent receives is thin and directory-blind: `buildDefaultMcpServers` / `withDefaultMcpServers` (`entrypoint/agent-mcp/src/defaults.ts`) intended to merge defaults, and the spec records that `withDefaultMcpServers`, at the time of this decision, **no-opped** where it should merge (NAT-TOOL-4; implemented — see D4). The injection seam itself already exists — `dispatch-cli`'s `defaultDispatchMcpServers()` builds a base map and `resolveBacklogMcpEntry()` resolves the backlog entry package-relative (research `01M46B0SCSSVCJ4N55WB610DR5`) — so this work **extends an existing seam** rather than inventing one.

**The consequence is a portability failure.** A file-read or shell call that an agent makes has no guaranteed map to the dispatching directory. `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts` does not yet thread a per-server cwd into the spawned child, and the fs server's own cwd is the only scope it has. The fix must be first-class, because the state that decides the workspace root — the dispatching directory and env — is known only at dispatch.

**Four structural facts from the research shape the design (memory topic `agent-mcp-native-tooling`):**

1. **No first-party MCP shell server exists.** `modelcontextprotocol/servers` ships filesystem, fetch, git, memory, time, and more, but no shell server, and no `@modelcontextprotocol/server-shell` exists. `fs:true` has a reference target; `shell:true` does not — the best-fitting third-party server is `tumf/mcp-shell-server` (allowlisted argv + audit; `01M46AZC9ZCX11RVKE1C6PQENX`).
2. **No MCP server implements a first-class HITL primitive.** Approval is always the client's job. Therefore agent-mcp must **own the generic permission gate** (the host/harness layer mirroring opencode / Claude Code / Codex) — but the gate is **thin**: it matches **tool names** and owns no dangerous-command detection or command segmentation (D5). The adopted shell server's own model (an argv allowlist plus audit) is **not** that gate.
3. **An `ask` must always resolve to an action, and the safe action fails closed.** The resolution is a fixed chain — suspend (iff HITL is enabled), else escalate to the parent agent to the root, else deny (`01M46B0XHMAWV5WBW8J40KAZJC`; `01M46AWJ156GH74FY3K6G59M8M`; D5/D6). There is no session *existence* test: **every task is sessioned** (the noop-session path is retired), so applicability is decided by the HITL capability and by parenthood, never by whether a session happens to exist. `ephemeral` is a retention class (D6), not an interactivity property.
4. **A dispatched agent may itself dispatch.** The `dispatch` member surfaces agent-mcp's own MCP server so a sub-agent can call the real `task`/`agent` surface; it is the same server/config the host already launches, not a re-authored surface.

**Per-server cwd and env are first-class in the MCP SDK transport** (`StdioServerParameters.cwd?` / `env`), so no wrapper is needed to scope a server to the agent's project directory (research `01M46B0S…`; verified against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts`, 2026-10-05). One test constraint is recorded and binding: any e2e that spawns agent-mcp must pass an **isolated cwd** — agent-mcp's `loadEnvHierarchy` loads `<cwd>/.env` with `override:true` and will clobber pinned env vars otherwise.

**What the two returns settled.**

- **The product session/retention model** fixes the sessioned-everything and retention semantics: every task is sessioned (retire the noop-session path); `ephemeral` is the retention class `retention: 'ephemeral'|'retained'` (+ optional `ttlMs`); `ask` resolves via HITL capability and parenthood, not session existence; `nativeTooling.ephemeralAskPolicy` is deleted and `askPolicy` is retired in favor of a fixed chain plus the `hitl` toggle (D6).
- **The researcher D5 harness-vs-safety verdict** returns *rewrite thick → thin, not remove*: agent-mcp owns only the generic permission GATE (the generic hook system + one `pre:tool_call` hook, the HITL plumbing as the generic approval gate, tool-NAME allow/deny, a passthrough of the adopted server's own allowlist, and fail-closed asks); it owns no dangerous-command catalog, no command segmentation, and no per-command allow/ask/deny semantics. Hard enforcement is delegated to `srt` (wrapping both servers), the `tumf` shell argv allowlist, and the reference fs server's root scoping (D5, D7, D13).

**What is NOT established, stated plainly.** (a) The concrete third-party server adoption in D7 was **subsequently APPROVED and implemented** (NAT-TOOL-8; named owner `pseudosky`, 2026-10-05 — recorded in `@adhd/agent-core-native-tooling`'s catalog and in agent-mcp's `README.md`/`AGENTS.md`/gated test header); at authoring time it was human-gated and no dependency was added by this record alone. (b) The permission rule-resolution semantics are **now ratified**: Q1 chooses **last-match-wins with `deny` terminal** (D5); the earlier NAT-TOOL-2 / NAT-TOOL-6 conflict is resolved and NAT-TOOL-6 AC4 has been aligned. (c) This ADR's grounding is the umbrella/children (authoritative) plus the memory research; the memory recall returned a subset of the topic's episodes, and the specific ADR-0008 artifacts (package name, the exact value union) are set by the **umbrella spec**, not the research.

## Decision

### D1 — A standardized native toolset is a first-class default for dispatched agents

Every dispatched agent is resolved to a base native toolset covering **filesystem (`fs`)**, **shell (`shell`)**, and **dispatch self (`dispatch`)**. The default posture is enabled for `fs` and `shell` and present for `dispatch`. This is a default, not a mandate: any of the three may be disabled or replaced per agent (D3).

Merge precedence, highest first, is **explicit `mcpServers` > `nativeTooling` > `dispatch` self**. An agent's explicitly configured `mcpServers` always win; `nativeTooling` supplies the rest; the dispatch self-server is the floor. `withDefaultMcpServers` MUST **merge** (it no-opped at authoring time — `entrypoint/agent-mcp/src/defaults.ts`; now implemented); the fix is at that source (`adhd ADR-0002`), never a per-caller workaround.

**The `dispatch` member is agent-mcp's own MCP server.** It surfaces the real agent-mcp dispatch surface — the `task` / `agent` (and session) tools the host already exposes — to a dispatched agent, so that agent can dispatch sub-agents. The resolver MUST reference the **real agent-mcp MCP surface** (the same server entry / launch config the host loads), with the tool names the host actually registers. Authoring a weak/non-conformant wrapper — a bespoke mini-server, a renamed surface, or a hand-rolled shim — is **REJECTED**: it diverges from the surface consumers load and silently skips host wiring, dist resolution, and tool registration. `dispatch: true` means the standardized zero-override builtin that points at the real agent-mcp server.

### D2 — A core resolver package: `@adhd/agent-core-native-tooling`

A new **CORE**-tier package owns resolution and permission matching. It is scaffolded with the mandated generator (bare name `native-tooling`, group `agent`, `nxLayer logic`, `platform node`) into `packages/agent/agent-core-native-tooling`, and it publishes **CommonJS-only** (`adhd ADR-0003`).

Public surface:

- `resolveNativeTooling(cfg, { cwd, env, dispatchSelf }) -> McpServerConfig[]`
- `resolveNativeToolingMap(cfg, ctx) -> Record<string, McpServerConfig>` — the keyed `mcpServers` projection the host actually mounts; the array and map forms are the **same computation**, not two producers
- `matchPermission(ruleMap, toolName) -> PermissionAction` — matches the **tool name**, last-match-wins with `deny` terminal (D5). It **never** parses, matches, or segments command text.
- the **server catalog** (the fs/shell/dispatch server specs; the `dispatch` spec resolves to the real agent-mcp server, D1)

**The catalog is the single producer (NAT-TOOL-4 AC6).** The fs/shell launch literals — `npx -y @modelcontextprotocol/server-filesystem` and `uvx mcp-shell-server` — exist **only** in `packages/agent/agent-core-native-tooling/src/lib/catalog.ts`; no host hand-builds a second fs/shell server, and no host invents a divergent key (`filesystem` vs `fs`) for the same server.

CORE, not a plugin: resolution is required by the host (`entrypoint/agent-mcp`) and the dispatch host (`entrypoint/dispatch-cli`), and is a primitive both depend on, not an optional extension (umbrella spec "Decision"). The `ask`-**resolution** policy (D6) is evaluated by the engine/host, which alone holds the session/parent graph; the core package exposes the permission *matching*, not the escalation routing.

**There is deliberately no `segmentShellCommand` / command parser in this package.** Shell-command segmentation for safety is not the harness's job (D5); it belongs to the adopted server's argv allowlist and the OS sandbox.

### D3 — Typed `nativeTooling` config: `{ fs?, shell?, dispatch?, hitl? }`

`packages/agent/agent-base-types` gains:

```
AgentDefinition.nativeTooling?: NativeToolingConfig
NativeToolingConfig = {
  fs?:        FsToolConfig;
  shell?:     ShellToolConfig;
  dispatch?:  DispatchToolConfig;
  hitl?:      boolean;            // D6; default true; legacy alias `allowHumanInput`
}

FsToolConfig        = boolean | BuiltinFsOptionOverrides       | CustomMcpServerConfig
ShellToolConfig     = boolean | BuiltinShellOptionOverrides    | CustomMcpServerConfig
DispatchToolConfig  = boolean | BuiltinDispatchOptionOverrides | CustomMcpServerConfig
```

`askPolicy` and `ephemeralAskPolicy` are **retired** (D6): the ask chain is fixed and the only knob is `hitl`.

Each member means exactly one thing:

- **`false`** — the builtin for that tool is **not** resolved (no server emitted).
- **`true`** — the **standardized zero-override builtin** is resolved (the "zero-override case" of `BuiltinOptionOverrides`). `true` is an accepted **alias** and is **canonicalized internally to the override object** so the rest of the system deals with one representation. For `dispatch`, the builtin is the real agent-mcp server (D1).
- **`BuiltinOptionOverrides`** — resolve the standardized builtin, with the given overrides (e.g. `fs.root`; `shell.allowCommands` — a passthrough of the adopted server's own argv allowlist, **not** a per-command permission map, D5).
- **`CustomMcpServerConfig`** — a full `McpServerConfig` **replaces** the builtin for that tool.

The union is deliberately `boolean | …` (not `… | false`): `true` and `false` are both values, which keeps NAT-TOOL-1's `{fs:true,shell:true,dispatch:true}` ACs and its `boolean` typing intact while the canonical internal form is the override object. Zod validates the union so `{fs:{root:42}}` is rejected at the boundary (`agent-base-types/src/index.ts`, plus orchestrator-side validation where the definition is consumed, `packages/agent/agent-engine-orchestrator/src/interfaces.ts`). A definition with no server `cwd` still validates. The whole `nativeTooling` object survives a serialize → store → read round-trip.

### D4 — Resolution is at TASK time, against the dispatching cwd; the stored definition is immutable

agent-mcp resolves native tooling at **task time**, not definition-creation time. `resolveNativeTooling(def.nativeTooling, { cwd: runtimeCwd, dispatchSelf })` runs when the task fires, where `runtimeCwd` is the dispatching host's cwd. **The stored definition is never mutated by resolution.**

This is the portability guarantee: the same stored agent definition fired from `/P/a` then `/P/b` yields fs root `/P/a` then `/P/b`, while the stored JSON is **byte-identical**. A reused agent gets the **current** cwd on each fire, not the cwd it was first created with. The dispatch host (`entrypoint/dispatch-cli/src/lib/core.ts`, `buildProductionAgentMcpRunner`) sets `cwd = process.cwd()` and threads the cwd to the spawned agent-mcp child through **both** the create and reuse paths, so the child re-resolves the definition's declarative `nativeTooling` against the current cwd on every fire. The stored definition itself is **never mutated**: `ensureAgent` writes only the declarative config on create and performs no write on reuse (it never `agent_update`s a resolved map), and the host stores no resolved root. `--tools-root` stays consistent with the child's cwd.

### D5 — The permission gate is agent-mcp's own and it is **THIN**: tool-name `allow | ask | deny`, host-side before `pre:tool_call`; hard enforcement is **delegated**

The resolved permission map is evaluated **host-side**, before the `pre:tool_call` hook, for every tool call. Actions are `'allow' | 'ask' | 'deny'`. The gate matches the **tool name** — never the command text. The model is **modelled on** opencode's gate, not imported (opencode's permission engine is not published, `01M46AWJ156GH74FY3K6G59M8M`); what agent-mcp copies is the *gate shape* (a pre-call decision over a pattern→action map), not the command-matching layer.

**The gate is consulted for every tool call, and the blast radius is explicit.** The engine holds no server taxonomy and cannot distinguish "native" from non-native, so it calls the injected gate for every tool call; `defaultPermissionGate` merges each `nativeTooling.*.permissions` member into one flat map over server-qualified tool names with a `'*'` baseline. A bare `{'*':'deny'}` declared under ANY member therefore denies **every** server the agent can call — including non-native ones such as `backlog`/`memory`, not only `fs`/`shell`/`agent-mcp`. Rules SHOULD scope by server-qualified name (`fs.*`, `shell.*`, `agent-mcp.*`); the engine deliberately does not narrow the gate to a catalog.

In the shipped implementation the host (`entrypoint/agent-mcp/src/config.ts` `toEngineConfig()`) injects the resolved gate as `permissionGate`, and the engine (`packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts`) **enforces** it before `pre:tool_call` for every tool call — `deny` refuses with a typed `PERMISSION_DENIED` result and the tool is not executed; `ask` runs the fixed chain below (NAT-TOOL-6).

**The harness owns the GATE; it does not own the rules or the enforcement.** agent-mcp retains only:

- the **generic hook system + a single `pre:tool_call` enforcement hook** (already shipped);
- the **HITL suspend/resume plumbing** as the **generic human-approval gate** (already shipped);
- **tool-NAME allow/deny** (`matchPermission` matches the tool, never parses the command);
- a **passthrough/surface of the adopted server's own allowlist** (config plumbing only — agent-mcp configures it and passes it through; it does not re-derive it);
- **fail-closed asks**: a non-interactive dispatched subagent cannot answer an `ask`, so an unanswerable ask MUST resolve to a `deny` (D6) — never a hang, never an implicit allow.

agent-mcp **MUST NOT** own:

- dangerous-command **pattern catalogs** (regex blocklists / prefix allowlists over raw command text);
- shell-command **segmentation for safety** (no in-harness parser);
- **per-command** allow/ask/deny semantics for the shell tool;
- the fs/shell servers' internal safety.

Hard enforcement is **delegated** (D7):

- **OS sandbox → `@anthropic-ai/sandbox-runtime` (`srt`)**, wrapping **both** servers (filesystem confinement + network egress policy);
- **shell argv allowlist → `tumf/mcp-shell-server`** (allowlisted command NAMES as argv arrays, never a shell string);
- **filesystem root scoping → the reference fs server** (`@modelcontextprotocol/server-filesystem`, + Docker `ro`).

A harness that only pattern-matches command text is best-effort, **not a security boundary**; the OS sandbox is the boundary and the server's argv allowlist is what the tool accepts at all (`01M4724ZFSFWK182N4Y2HPMTTE`).

**Rule-resolution semantics — RESOLVED (Q1 ratified 2026-10-05): LAST-MATCH-WINS, with `deny` terminal.** The children conflicted (NAT-TOOL-2 last-match-wins vs NAT-TOOL-6 most-restrictive-wins) and their ACs could not both hold against one implementation. The owner ratified **last-match-wins** — faithful to "opencode-style" and required by NAT-TOOL-2 AC3 — **plus the invariant that `deny` is terminal**: once any `deny` matches, the result is `deny` regardless of later rules. This preserves ordered-rule ergonomics while keeping the deny guardrail absolute. NAT-TOOL-6 AC4 (most-restrictive-wins) is **superseded** and has been aligned (Backlog reconciliation).

Because the gate matches **tool names**, the rule-map keys are tool names (e.g. `agent-mcp.*`, `fs`, `shell`), not command patterns. This governs whether a dispatched agent can invoke agent-mcp's own `task`/`agent` tools. A broad rule that a later explicit `allow` is to override must be **non-terminal**: `{'*':'ask','agent-mcp.*':'allow'}` → dispatch allowed (last-match-wins picks the later `allow`, and `ask` is not terminal). A matched `deny` **is** terminal, so `{'*':'deny','agent-mcp.*':'allow'}` → dispatch **denied** — no later rule, including the explicit `allow`, can override it; that is exactly how a broad `deny` stays absolute.

- **`deny`** → a typed refusal is returned to the caller and the tool is **not executed**.
- **`ask`** → resolved by the ask-resolution policy (D6): suspend, escalate-to-parent, or deny.
- **Defaults:** base tools `allow`; explicit **tool-name** `deny` guardrails. Deliberate — the default toolset must be usable without an interactive answer.

### D6 — Every task is sessioned; `ask` resolves via HITL capability / parent; `ephemeral` is a session-retention class

**Every task is SESSIONED.** The noop-session path is retired: a one-shot dispatch by `agent_name` creates a **real session**, not a sessionless placeholder. A session therefore always exists, so an `ask` is never answered by "there is no session" — applicability is decided by the HITL capability and by parenthood (below).

**`ask` is not a terminal state, and it is not resolved by session *existence*.** When a rule resolves to `ask`, the **ask-resolution policy** decides what happens, as an **ordered, fixed fallback chain** over three resolutions:

- **`suspend`** — sessioned HITL: the session suspends and later resumes; the user's "always" answer is recorded as a typed rule. **Applicable iff `nativeTooling.hitl !== false`** (HITL is enabled).
- **`escalate`** — the ask is routed to the **parent agent** for approval (parent-approves-HITL). A dispatched sub-agent's `ask` is surfaced to the agent that dispatched it; that parent may itself be interactive (approve directly), may escalate further up the parent chain, or may itself be subject to this same policy. **Applicable iff a parent exists**; escalation follows the existing parent/child graph to the **root** and is **bounded** (v1: by parent-chain depth — `EngineConfig.escalationMaxDepth`, default 3; a task may escalate only while its `recursionDepth` is strictly below the bound). The ask is **delivered to the parent task**: the parent is parked in `awaiting_input` holding the resume token while the child waits **tokenless**, so a resumed **parent** (`task_resume`) resolves the child — approval executes the tool, rejection denies it — and the child can never approve its own ask. At or over the bound, or when the parent cannot be reached, the ask fails closed to `deny`.
- **`deny`** — the request is refused with a typed error (`permission_ask_denied`); the tool is not executed. This is the **fail-closed floor**: when neither suspend nor escalate applies, the result is `deny` — never a hang and never an implicit allow.

The chain is **fixed** (there is no configurable order):

```
type AskResolution = 'suspend' | 'escalate' | 'deny';
// resolution order is fixed: ['suspend', 'escalate', 'deny']
//   suspend : iff nativeTooling.hitl !== false      (HITL enabled)
//   escalate: iff a parent exists (bounded to the root)
//   deny    : the fail-closed floor
```

`nativeTooling.askPolicy` is **retired**: the order is fixed and the only knob is HITL enablement.

**Disabling HITL is typed config: `nativeTooling.hitl: false`** (legacy alias `allowHumanInput`). Disabling HITL **hides `request_human_input`** and **prunes `suspend`** from the chain; an `ask` then degrades to **`escalate`** (if parented) or **`deny`** (at the root). It is typed config, **not** an env feature switch (`adhd ADR-0001`; `sox ADR-0013`).

**`ephemeral` is a session-retention CLASS — not an interactivity or HITL property.** A session is stored whether or not it is ephemeral; the class governs **reclamation**:

```
type RetentionClass = 'ephemeral' | 'retained';
interface SessionRetentionPolicy {
  retention: RetentionClass;   // default: 'ephemeral' for a one-shot dispatch
  ttlMs?: number;              // optional reclaim TTL
}
```

- **`ephemeral`** — **reclaim on terminal** (one-shot): when the session's task reaches a terminal state, the session is garbage-collected.
- **`retained`** — keep the session **until `session_close`**.
- **Never reclaim a session that has a non-terminal task** (in either class).

Interactivity is determined by the HITL capability (`hitl !== false` → suspend is applicable) and by parenthood (escalate), never by ephemerality. A session can therefore be ephemeral *and* interactive, or retained *and* non-interactive. The former `nativeTooling.ephemeralAskPolicy` field is **deleted**; retention is a session/run property (`SessionRetentionPolicy` — `retention`, optional `ttlMs`), never a native-tooling field.

### D7 — Adopt upstream MCP servers; never author new ones (human-gated)

adhd **adopts** third-party MCP servers and authors only the thin resolver/config adapter (D2). The catalog:

| role | server | status |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | **adopt** — first cut |
| shell | `tumf/mcp-shell-server` (MIT; allowlisted argv array, never a shell string; audit logs) | **adopt** — first cut |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) — wraps **both** servers | **adopt** — first cut |
| command segmentation | `unbash` (ISC, 0-dep) | **DROPPED** — see below |
| read-only-roots alternative | `rust-mcp-filesystem` (read-only by default) | **deferred** |

**`unbash` is dropped.** Adopting it *inside the harness* means the harness owns shell-command segmentation for safety — the exact responsibility this ADR delegates to the adopted server's argv allowlist and the OS sandbox (D5). It is only adoptable if the harness genuinely owns a command layer; it does not (`01M47253250MJNMN15QJ4V21RN`).

**The adopted shell server is not the permission gate.** `tumf/mcp-shell-server` gives **allowlisted argv + audit**, **not** opencode-style `allow | ask | deny`; the gate is agent-mcp's own (D5). The server is adopted for **safe execution** — command names as argv arrays, never a shell string, with timeout/output caps and an env allowlist.

**This was a HUMAN-GATED decision (NAT-TOOL-8) — APPROVED 2026-10-05.** The approval is recorded with a **named owner (`pseudosky`) in all three of `README.md`, `AGENTS.md`, and the gated test header** (per the repo's live-testing/gating rule), and the adopted set is wired in `@adhd/agent-core-native-tooling` (`catalog.ts`). The authored shell server is retired — **removed, not grown** (Consequences). No bash-string ever reaches a shell: shell execution is allowlisted command **names as argv arrays**.

### D8 — Portable agent definitions

`AgentDefinition.nativeTooling?` is part of the portable, persisted definition. Because resolution is task-time (D4), the **definition carries no resolved root**; it carries only the declarative config (D3). This is what makes one stored definition usable from any directory. A definition written before this ADR (no `nativeTooling`) still validates and behaves as if the standardized defaults applied.

### D9 — cwd/env propagate to every spawned MCP child

`McpServerConfig.cwd` is threaded through the engine's MCP client layer (`packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `registry.ts`) into the spawned stdio child's working directory; `subprocessEnv()` reaches the child; a server spawned via the `claudecli` provider (`providers/claudecli.ts`) inherits the configured cwd. A server with **no** `cwd` still inherits the parent process cwd (unchanged behavior).

### D10 — Config surface is typed-only in `@adhd/environment`

`packages/environment/environment-base-spec` gains `FieldSpec`s for `nativeTooling.fs.*`, `nativeTooling.shell.*`, `nativeTooling.dispatch.*`, and `nativeTooling.hitl` (legacy alias `allowHumanInput`), with the normal code → system → global → project → env cascade. Session retention (`retention`, optional `ttlMs`) is a session/run config surface, not a native-tooling field (D6). **No env feature toggles** (`adhd ADR-0001`; `sox ADR-0013`). The legacy `ADHD_AGENT_SHELL_MCP_PATH` is **retired/removed**: it fed the authored `tools/mcp-shell/server.mjs`, which NAT-TOOL-4 deleted. Shell configuration is now the typed `nativeTooling.shell.*` surface (D7); no shell MCP-path field is re-introduced.

### D11 — The acceptance gate is a real dispatched agent, with an expanded negative-control set

The feature is proven through **real components**, never a unit test of internals (NAT-TOOL-9, per the repo verification standard). A real dispatched agent from `/P` with `{fs:true, shell:true, dispatch:true}` reads `/P/<file>` and runs a shell command in `/P`; the same definition fired `/P` then `/Q` gets each own root with byte-identical stored JSON; a sessioned `ask` suspends+resumes; a sub-agent `ask` escalates to the parent and the parent approves; an ephemeral session is reclaimed on terminal while a retained session survives to `session_close` (and no non-terminal session is reclaimed). The e2e spawns agent-mcp with an **isolated cwd + fake HOME** (the `.env override:true` leak).

**Negative controls (each a deliberate revert / wrong-variant that MUST turn the suite RED):**

1. Revert the NAT-TOOL-4 merge (`withDefaultMcpServers` back to a no-op) → a dispatched agent loses the default servers → RED.
2. Revert the NAT-TOOL-3 cwd propagation → fs/shell roots fall back to the parent cwd → RED.
3. Revert task-time resolution to definition-time (persist the resolved servers) → a `/Q` fire leaks the `/P` root → RED.
4. Thread cwd on the ensure path only (drop it on the reuse path) → a reused agent keeps its first cwd → RED.
5. Disable host-side permission evaluation (move it after `pre:tool_call`, or remove it) → a `deny`-matched tool executes → RED.
6. Flip the **ratified** rule-resolution semantics to the rejected most-restrictive-wins variant → the last-match-wins + terminal-`deny` assertion fails → RED.
7. Point `dispatch` at a stub / weak wrapper instead of the real agent-mcp MCP surface → a real sub-dispatch (`task`/`agent`) from a dispatched agent fails → RED.
8. Revert parent-escalation routing → a sub-agent `ask` no longer reaches the parent (hangs or auto-denies) → RED.
9. Make an unanswerable `ask` default to `allow` (fail-open) → the fail-closed assertion → RED.
10. Treat `ephemeral` as a retained / never-reclaimed session (or reclaim a session with a non-terminal task) → the retention/GC assertion → RED.
11. Prove the `hitl:false` path leaves `request_human_input` visible (or `suspend` in the chain) → the pruning assertion → RED.
12. Add command-text parsing / segmentation to the harness gate (an in-harness `unbash`-style splitter or a dangerous-command catalog) → the thin-gate delegation assertion (the gate matches tool names only; enforcement lives in srv/argv allowlist) → RED.
13. Reintroduce the noop-session path (a one-shot `agent_name` dispatch with no session) → a sessioned `ask` has nothing to suspend → RED.
14. Remove the isolated cwd + fake HOME from the e2e → `.env override:true` clobbers a pinned env var → RED.

### D12 — Acceptance authorizes implementation; NAT-TOOL-8 keeps its own human gate

The owner has approved this record; the umbrella/children may now be implemented against it (`adhd ADR-0002` — correct the source). The upstream-server adoption in D7 was subject to the **separate** human-gated approval NAT-TOOL-8 requires; that approval was recorded 2026-10-05 (named owner `pseudosky`) in all three required places, and the adopted servers are wired in `@adhd/agent-core-native-tooling`.

### D13 — Layering test: fs/shell MCP servers are OPTIONAL ease-of-use integrations, not an underlying system

The fs and shell MCP servers, and their `nativeTooling` members, are **optional ease-of-use integrations** — an agent can run without them, and any of the three members can be disabled (D1/D3). They are **not** an underlying system agent-mcp depends on for its core loop. This contrasts deliberately with the concerns agent-mcp **does** own:

- **the execution loop / interrupt-handling** (resume, suspend, cancellation) — agent-mcp owns it;
- **tool-calling** (the MCP client seam, tool registration, dispatch self) — agent-mcp owns it;
- **the generic permission gate + HITL plumbing** — agent-mcp owns it (D5);
- **filesystem ease-of-use, shell ease-of-use, their argv allowlists, and OS enforcement** — **delegated** to adopted servers/`srt`, optional, replaceable, disable-able.

Collapsing these (e.g. making the shell server load-bearing for the loop) would make a third-party server an un-ownable, un-disable-able dependency and blur the harness/safety boundary D5 draws.

## Consequences

- **Portability becomes a property of the resolver, not of the stored definition.** The same definition is directory-independent; a future caller must not persist resolved `mcpServers` back onto a definition or it silently reintroduces the definition-time-root bug D4 exists to remove.
- **One choke point owns the toolset.** `resolveNativeTooling` + the server catalog are the single place a new base tool is added; two hosts (`agent-mcp`, `dispatch-cli`) consume the same primitive.
- **Every task is sessioned, and `ephemeral` is retention, not interactivity.** The noop-session path is gone; any code or doc that equates ephemeral with "cannot answer an `ask`", or that resolves `ask` by session existence, is stale and must be corrected. Retention/GC and interactivity are orthogonal.
- **`ask` always resolves and fails closed.** `deny` is the floor when neither HITL-capability (suspend) nor a parent (escalate) can answer; the default-`allow`-with-tool-name-`deny`-guardrails posture keeps the base toolset usable while an unanswered `ask` cannot hang or silently allow.
- **Escalation is recursive and must be bounded.** Parent-approves-HITL follows the parent chain and terminates at the root; an unbounded chain would allow an unbounded wait, so the policy carries an explicit bound (v1 parent-chain depth).
- **The permission gate is thin, and the adopted server is not it.** agent-mcp owns the generic gate (hooks, HITL, tool-NAME allow/ask/deny, server-allowlist passthrough, fail-closed asks) and nothing more; a harness that pattern-matched command text or segmented commands would be best-effort, not a boundary, and is forbidden (D5). Enforcement is delegated to `srt`, the `tumf` argv allowlist, and the fs server's root scoping.
- **`tools/mcp-shell/server.mjs` is the removed thick layer.** The former server was itself an instance of the thick layer (an `ALLOWED_COMMAND_PREFIXES` + `BLOCKED_PATTERNS` regex catalog over command text). Under this ADR it is **removed, not grown** — replaced by the adopted `tumf/mcp-shell-server` (argv allowlist + audit) wrapped by `srt`. Its removal was gated by NAT-TOOL-8's human approval (D7; approved 2026-10-05).
- **The upstream dependency set is a supply-chain surface.** Adoption (D7) is gated precisely because it adds third-party code; the fs server's per-root read-only is Docker-only, and the shell server is explicitly **not** a sandbox — hence `srt` is adopted **in the first cut** (not held in reserve) to wrap both servers.
- **The permission semantics are settled, not carried.** Q1 ratified last-match-wins with terminal `deny`; both NAT-TOOL-2 and NAT-TOOL-6 ACs are aligned to it (Backlog reconciliation). No semantics conflict remains open.
- **A new public package and new public types are a semantic-version concern** for `@adhd/agent-core-native-tooling` and `agent-base-types` (additive; D3 adds optional fields, and retires the never-shipped `askPolicy`/`ephemeralAskPolicy` names).

## Alternatives considered

- **Author a first-party fs/shell MCP server.** **REJECTED.** A first-party shell server would duplicate `tumf/mcp-shell-server`'s allowlist/audit/hardening, and a first-party fs server would duplicate the reference server. The research's whole build-vs-integrate verdict is "integrate the servers; build only the thin adapter" (`01M46AWJ156GH74FY3K6G59M8M`).
- **Author a wrapper for the `dispatch` surface.** **REJECTED.** It diverges from the real agent-mcp MCP surface consumers load and skips host wiring / dist resolution / tool registration; D1 requires pointing at the real server.
- **Own dangerous-command detection / command segmentation in the harness (the thick layer).** **REJECTED.** A harness that pattern-matches command text is best-effort, not a security boundary; detection belongs to the server's argv allowlist and the OS sandbox (D5; `01M4724ZFSFWK182N4Y2HPMTTE`).
- **Adopt `unbash` inside the harness for command segmentation.** **REJECTED.** It re-owns segmentation — the responsibility this ADR delegates — so it is dropped from the adopt set (D7).
- **Adopt `tumf/mcp-shell-server` for its permission model.** **REJECTED as a rationale.** It ships allowlisted argv + audit, not `allow | ask | deny`; the permission gate is agent-mcp's own and thin (D5). The server is adopted for safe execution only.
- **Resolve the toolset once, at definition-creation time, and persist the resolved servers.** **REJECTED.** It is the exact portability failure this ADR removes: the stored definition would pin the root it was created in, so firing from `/Q` would leak `/P`. NAT-TOOL-4's negative control (reverting to definition-time resolution) turns the portability test RED.
- **`ephemeral` = non-interactive / no-HITL.** **REJECTED.** `ephemeral` is a session-retention class; a session is stored whether or not it is ephemeral, and interactivity is decided by the HITL capability or a parent, not by ephemerality.
- **Resolve `ask` by session existence.** **REJECTED.** Every task is sessioned, so existence is not a discriminator; applicability is the HITL capability (suspend) and parenthood (escalate).
- **`ask` = deny whenever the task cannot suspend.** **SUPERSEDED.** Parent-approves-HITL is a first-class resolution ahead of deny; deny remains the fail-closed floor only when no HITL capability and no parent can answer.
- **Most-restrictive-wins for rule resolution.** **REJECTED (Q1).** The owner ratified last-match-wins with terminal `deny`; most-restrictive-wins (NAT-TOOL-6 AC4) is superseded (D5).
- **Import opencode's permission engine.** **REJECTED.** It is not published standalone (`01M46AWJ…`); only the *gate shape* is modeled, and the command-matching/segmentation part is explicitly **not** adopted.
- **`ask` as the default for base tools.** **REJECTED.** The default toolset would fail on first use; default-`allow`-with-`deny`-guardrails is the recorded answer (Context fact 3).
- **`@wonderwhy-er/desktop-commander` as the shell server.** **REJECTED.** Blocked by the research verdict for blocklist + CVE (`01M46AWJ…`).
- **Config via env-var feature toggles.** **REJECTED.** Violates `adhd ADR-0001` / `sox ADR-0013` (D6, D10).

## ADR compliance

- **`adhd ADR-0001` / `sox ADR-0013` — typed config, never env feature toggles.** Every switch in this ADR is a typed config field: `nativeTooling.fs.*`, `nativeTooling.shell.*`, `nativeTooling.dispatch.*`, `nativeTooling.hitl`, and the session retention policy (`retention`, `ttlMs`). No `*_ENABLED` / `*_NATIVE_TOOLING` feature switch is introduced; NAT-TOOL-7's gate is an explicit "prove NO new feature-switch env var exists". `ADHD_AGENT_SHELL_MCP_PATH` is **retired** with the authored server it pointed at (NAT-TOOL-4); shell configuration is `nativeTooling.shell.*`. (This ADR adds no store, so `adhd ADR-0001`'s sox-store-adapter/multiprocess mandate is not engaged.)
- **`adhd ADR-0002` — correct the source, never work around.** The `withDefaultMcpServers` no-op is fixed at its source (`entrypoint/agent-mcp/src/defaults.ts`), not patched per caller; the base toolset is resolved by one core package rather than re-implemented in each host; the cwd propagation is fixed in the engine client, not shimmed per provider.
- **`adhd ADR-0003` — CJS-only.** `@adhd/agent-core-native-tooling` publishes CommonJS-only (`main: ./dist/index.js`, `type` unset, no `module`, no `exports`); its acceptance gate includes `require(dist)` loading without throwing.
- **`adhd ADR-0004` — MCP flat payload.** Unaffected; this ADR does not change any tool's return envelope (`adhd ADR-0006`'s `{ok,data}` outcome envelope remains the tool's own flat return).
- **`adhd ADR-0006` / `adhd ADR-0007` — backlog surface.** Unaffected; this ADR touches no backlog verb.
- **Repo live-testing / gating rule.** NAT-TOOL-8's human gate is documented in all three required places when an approval is recorded; the default-running e2e (D11) is the proof, not a gated suite.

## What does NOT change

- **The existing injection seam.** `dispatch-cli`'s `defaultDispatchMcpServers()` / `resolveBacklogMcpEntry()` and the backlog MCP entry stay; this ADR extends them (research `01M46B0S…`).
- **The backlog and memory servers** an agent already receives — they remain, alongside the native toolset.
- **A server with no `cwd`** still inherits the parent process cwd (D9).
- **The permission model's vocabulary** — `allow | ask | deny` over a pattern→action map — is adopted, not redesigned; the resolution rule is now **ratified** (last-match-wins, terminal `deny`), and the resource matched is the **tool name**, not the command.
- **`adhd ADR-0001`'s store substrate and multiprocess mandate** — not engaged (no store). **`adhd ADR-0002`** is applied, not amended.
- **No dependency is added, and no file is removed, by this record's mere existence** — D7's adoption (and `tools/mcp-shell/server.mjs`'s removal) waited on its own human gate (approved 2026-10-05).

## Backlog reconciliation — NAT-TOOL children

The two returns change several child ACs. The deltas are named precisely here; none is applied silently. Items not listed are unchanged.

- **NAT-TOOL-1 `65d3ffa3` — two AC deltas.** Its `FsToolConfig = boolean | FsBuiltinOverrides | McpServerConfig` (and the same for `shell`/`dispatch`) stands, and `true` remains the zero-override builtin (D3). **But AC1's shell override example `{fs:true, shell:{permissions:{'rm *':'deny'}}}` must change**: the thin gate owns **no per-command permissions** (D5). Shell overrides carry the adopted server's **argv allowlist** (`allowCommands`) plus tool-NAME rules; `rm *` is expressed server-side, not as a harness permission. Additionally, `NativeToolingConfig.askPolicy`/`AskPolicy` are **retired** (D3/D6) and must be removed from NAT-TOOL-1's declared type list and its AC5 (`{hitl:true, askPolicy:<valid>}` → `{hitl:true}`); the type survives only as a `@deprecated` tombstone accepted at the validation boundary and ignored by the resolver.
- **NAT-TOOL-2 `efd234d7` — unblocked, no AC change.** Q1 ratifies **last-match-wins with terminal `deny`**, so AC3 stands; the D5 rewrite narrows the matched resource to the **tool name** (its shell-command examples narrow to tool-name/tool-name-pattern resources).
- **NAT-TOOL-6 `4c89ef9a` — must be reconciled.** (a) AC3's `ephemeralAskPolicy='allow'` negative-control flip is obsolete: `ephemeral` no longer means non-interactive, `ephemeralAskPolicy` is deleted, and `askPolicy` is retired. (b) A new AC is required: a sub-agent `ask` **escalates to the parent agent**, the parent approves, and the tool proceeds. (c) **AC4 (most-restrictive-wins) is superseded** by Q1 (last-match-wins + terminal `deny`) and must be deleted/aligned. (d) Any AC implying the harness parses/segments shell commands must be removed (thin gate, D5).
- **NAT-TOOL-7 `0f624014` — must be reconciled.** The `FieldSpec` list changes from `nativeTooling.ephemeralAskPolicy`/`nativeTooling.askPolicy` to `nativeTooling.hitl` (plus `nativeTooling.dispatch.*`); session retention (`retention`/`ttlMs`) is a session/run config surface, not a native-tooling field. AC1/AC2 stand; AC3's no-new-env-switch assertion stands.
- **NAT-TOOL-8 `01351dfc` — must be reconciled.** (a) Record that `tumf/mcp-shell-server` provides **allowlisted argv + audit only, not `allow | ask | deny`** — the gate is agent-mcp's own (D5). (b) Confirm the first-cut adopt set: **`filesystem` + `tumf/mcp-shell-server` + `@anthropic-ai/sandbox-runtime` (`srt`)**; **`unbash` is dropped**; `rust-mcp-filesystem` deferred. (c) AC1's **named human-approval owner is left blank** for the owner to supply. (d) The harness must own no dangerous-command catalog and no command segmentation (D5/D13); `tools/mcp-shell/server.mjs` is removed, not grown.
- **NAT-TOOL-9 `c63fd05c` — must be reconciled.** AC3 must change: "HITL sessioned `ask` suspends+resumes; ephemeral `ask` denies" becomes "sessioned `ask` suspends+resumes; a sub-agent `ask` escalates to the parent; an `ask` with no HITL capability and no parent denies". AC4's negative-control set must expand to D11's list.
- **Umbrella `532e44a4` — must be reconciled.** Its Outcome says "HITL accounting is fail-closed for ephemeral tasks"; correct to "every task is sessioned; `ask` resolution is fail-closed when neither the HITL capability nor a parent can answer — `ephemeral` is a retention class, not an interactivity property".
- **`cf70080c` (semantics-conflict item) — RESOLVED.** Q1 settled last-match-wins with terminal `deny`; NAT-TOOL-2 stands and NAT-TOOL-6 AC4 is superseded.

**Implied new items (filed with this record, children of the umbrella):** (1) the ask-resolution / parent-escalation policy (fixed chain, bounded escalation, parent-approves-HITL); (2) the session-retention / GC policy for `ephemeral` (reclamation-on-terminal, TTL, never-reclaim-non-terminal); (3) the sessioned-everything retirement of the noop-session path.

## Owner ratification (all six RESOLVED)

All questions were resolved 2026-10-05. Per the owner's disposition — "merge once all questions are resolved and corrected" — this record is **ACCEPTED**. Recorded here with the chosen answer so the record is self-contained.

1. **Permission rule-resolution semantics (D5) — RESOLVED: last-match-wins, with `deny` terminal.** Q1 ratified. NAT-TOOL-2 AC3 stands; NAT-TOOL-6 AC4 (most-restrictive-wins) is superseded and has been aligned. The gate matches **tool names** (D5), not command text.
2. **NAT-TOOL-8 named human-approval owner — RESOLVED as supplied at the adoption gate.** The name is required in `README.md` + `AGENTS.md` + the gated test header, and was supplied there on 2026-10-05 as **`pseudosky`** (the owner); it is not invented in this record.
3. **Adopt set — RESOLVED: `filesystem` + `tumf/mcp-shell-server` + `@anthropic-ai/sandbox-runtime` (`srt`, wrapping both servers), all first cut.** **`unbash` dropped**; `rust-mcp-filesystem` deferred. (C)
4. **`ask` resolution and escalation bounds (D6) — RESOLVED: fixed chain `['suspend', 'escalate', 'deny']`.** `suspend` iff `nativeTooling.hitl !== false`; `escalate` iff a parent exists, bounded to the root by parent-chain depth; `deny` is the floor. `askPolicy` is retired (the chain is fixed); `escalateTo` is `parent`.
5. **Session-retention default (D6) — RESOLVED: every task is sessioned; a one-shot dispatch defaults to `retention: 'ephemeral'` (reclaim on terminal), `retained` keeps until `session_close`, and a session with a non-terminal task is never reclaimed.** The `retention` class + optional `ttlMs` is the retention surface.
6. **Acceptance-gate negative controls (D11) — RESOLVED: the D11 set is the required RED set.**

**Resolved and folded in earlier:** the `true` alias (D3 — kept); the `dispatch` field shape (D1 — agent-mcp's own real server, `dispatch: true` = that server).

## References

- Owner directive, 2026-10-04 — "Draft ADR-0008 for my review first."
- Owner answers + clarifications, 2026-10-05 (Q1–Q6): Q1 — permission rule-resolution semantics; Q2 — the `true` alias; Q3 — `tumf/mcp-shell-server` gives allowlisted argv + audit, not `allow/ask/deny`, and NAT-TOOL-8's named owner stays blank; Q4 — `dispatch` is agent-mcp's own MCP server; Q5 — `ephemeral` is a retention class and `ask` gains parent escalation; Q6 — broaden the acceptance gate's negative controls.
- Final reconciliation returns, 2026-10-05: the **product session/retention model** (every task sessioned; retention class; `ask` via capability/parent; `hitl` disable; delete `ephemeralAskPolicy`; retire `askPolicy`); the **researcher D5 harness-vs-safety verdict** — memory `01M4725749GX9Y6QY10QQ5DH62`, `01M472587Y6H712DSPSMWFDZHM`, `01M4724WXRDC8DSEVT9N0V7S4Y`, `01M4724ZFSFWK182N4Y2HPMTTE`, `01M47253250MJNMN15QJ4V21RN`, `01M472509Q75DJECRBYJH1SEJM`.
- D5 verdict sources: `marktechpost.com` (agent harness vs framework vs MCP — who owns the loop/state/tools/permissions/recovery, 2026-09-14); `modelcontextprotocol.io/specification/2026-07-28`; `github.com/anthropics/sandbox-runtime`; `github.com/tumf/mcp-shell-server`; `developers.openai.com/codex/exec-policy`; `renezander.com/blog/sandbox-ai-coding-agent`; `arxiv.org/abs/2607.25890` (SHarD).
- Backlog: umbrella `532e44a4-e9c7-41c0-adda-b2823542f832`; NAT-TOOL-1 `65d3ffa3`, NAT-TOOL-2 `efd234d7`, NAT-TOOL-3 `a1f7d795`, NAT-TOOL-4 `9ada962a`, NAT-TOOL-5 `65799fd5`, NAT-TOOL-6 `4c89ef9a`, NAT-TOOL-7 `0f624014`, NAT-TOOL-8 `01351dfc` (human-gated), NAT-TOOL-9 `c63fd05c`, NAT-TOOL-10 `e50abc41`; semantics-conflict item `cf70080c-5eef-4d1a-9bf3-ffba6ccbe3d6`.
- Memory topic `agent-mcp-native-tooling`: build-vs-integrate verdict `01M46AWJ156GH74FY3K6G59M8M`; landscape gap `01M46B0XHMAWV5WBW8J40KAZJC`; `tumf/mcp-shell-server` `01M46AZC9ZCX11RVKE1C6PQENX`; injection seam `01M46B0SCSSVCJ4N55WB610DR5`; stdio per-server cwd `01M462BWBGS4ZNE20F9NJAADSA`.
- Repo seams: `entrypoint/agent-mcp/src/defaults.ts` (`buildDefaultMcpServers`, `withDefaultMcpServers`), `entrypoint/agent-mcp/src/server.ts`, `entrypoint/agent-mcp/src/config.ts`, `packages/agent/agent-base-types/src/index.ts`, `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts`, `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts`, `entrypoint/dispatch-cli/src/lib/core.ts`, `packages/environment/environment-base-spec/src/index.ts`, `tools/mcp-shell/server.mjs`.
- `adhd ADR-0001` (stores → sox-store adapter; typed config, no env toggles), `adhd ADR-0002` (correct the source), `adhd ADR-0003` (CJS-only), `adhd ADR-0004` (MCP flat payload).
- `sox ADR-0013` — `sox-ecosystem/docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`.
- Upstream: `github.com/modelcontextprotocol/servers/tree/main/src/filesystem`, `github.com/tumf/mcp-shell-server`, `github.com/anthropics/sandbox-runtime`. (`unbash` is dropped; `rust-mcp-filesystem` deferred.)
