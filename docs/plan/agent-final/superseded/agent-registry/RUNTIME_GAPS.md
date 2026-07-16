# Agent Registry — Runtime Gap Findings (Platform-Native Tools)

> **Design-pass notice.** This document records gaps surfaced while evaluating whether the
> agent-registry design covers agent-mcp's *runtime* need to grant agents provider/platform-native
> tools (web search, code execution, native browser, local built-ins). It is an analysis note, not
> a specification. It exists so that whoever architects `@adhd/agent-provider` and the agent-mcp
> refactor is not surprised by the compile-time ↔ runtime boundary described below.
>
> **Provenance.** Surfaced 2026-06-22 during a review of this plan against a live request to let
> `anthropic`/`openai` agents use platform-native tools. Tracked operationally as **FEAT-007** in
> `packages/ai/agent-mcp/BACKLOG.md`.

---

## Question Asked

> Can an agent creator specify which platform-internal (provider-native) tools an agent may use —
> Claude Code built-ins (`Read`, `Bash`, `WebSearch`, Chrome integration), Anthropic API
> server-side tools (`web_search`, `code_execution`), OpenAI built-ins (`code_interpreter`) — and
> does this plan cover that?

**Verdict: substantially, for *declaration and compilation* — but not for *runtime execution*.**

---

## What the Plan Already Covers

The tool/provider domains are effectively the "canonical capability + per-platform binding"
interface, which is the right design and supersedes any per-provider string-prefix scheme:

| Need | Mechanism in this plan |
|---|---|
| Per-agent tool grants | `AGENT_TOOL` junction (`DATA_MODEL.md` §"Agent-Tool Junctions") |
| Provider-agnostic naming | Canonical tools (`web_search`, `shell_exec`) + `TOOL_PLATFORM_BINDING` (`SEED_DATA.md` §6) |
| Cross-provider portability | Platform chosen at **compile** time, not baked into the record (`USAGE.md`) |
| Correct per-provider tool *schema shape* | `PROVIDER_TOOL_FORMAT` (`@adhd/agent-provider`) |
| Local vs server-run vs MCP-backed | `tool_type`, binding `availability`, `requires_mcp` |

This also resolves a concern raised during the review — that an agent-mcp `AgentDefinition` carries
only **one** provider, which would make a multi-namespace tool list mostly dead config. Because the
registry models tools as canonical and selects the platform at compile time, the single-provider
limitation disappears: the same record compiles to any platform.

---

## Gap 1 — Compile-Time vs Runtime Boundary

The registry is a **design-time / compile-time** concern (`SCOPE.md` → "What This Plan Does Not
Do"). It produces a `composed.tools` array for a target platform. It does **not** make agent-mcp's
**provider adapters** actually:

1. **forward** those platform tools to the provider API on each call, and
2. **execute** client-side tools (run an execution loop and return results to the model).

Concretely, today `agent-mcp/src/providers/anthropic.ts` → `toAnthropicTools()` only emits *custom*
tools (`{ name, description, input_schema }`). It never emits Anthropic **server-side** tool types
(e.g. a `{ type: "web_search_…" }` entry). A perfect compiler output would still not reach the
model, because the runtime adapter drops it. The `ProviderAdapter.stream(messages, tools, model)`
seam (`DATA_MODEL.md` §"ProviderAdapter Interface") is where this wiring must live, and it is
explicitly out of registry scope.

**Implication:** the registry closing this gap is **necessary but not sufficient**. agent-mcp needs
a parallel runtime change to honor compiled platform tools.

---

## Gap 2 — Tricky Native-Tool Cases Not Enumerated

The seed catalog (`SEED_DATA.md` §6) lists `web_search`, `web_fetch`, `shell_exec`, etc. as
canonical capabilities, but the following provider-native realities are not seeded or specified.
The *mechanism* to express each exists (binding `invocation_note`, `requires_mcp`,
`PROVIDER_TOOL_FORMAT`), so these are data + runtime-handling gaps, not schema gaps:

- **Anthropic server-side tools** (`web_search`, `code_execution`) carry **versioned `type`
  strings** and no `input_schema`; they execute on Anthropic's servers. `PROVIDER_TOOL_FORMAT`
  must capture this "type-tagged, server-executed" shape, and the runtime adapter must emit it.
- **Client-executed API tools** (`bash`, `text_editor`, `computer`) require agent-mcp to run a
  **local execution loop** and return tool results — a non-trivial runtime addition with real
  trust/sandboxing implications. No executor exists today.
- **Activation-flag tools** — e.g. Claude Code's Chrome integration requires the subprocess to be
  launched with `--chrome`, not merely listed in `tools:`. The binding `invocation_note` field is
  the intended home for "requires `--chrome`", but it is not seeded and the `claudecli` provider
  does not act on it.
- **MCP-backed native tools** — covered structurally via `requires_mcp` + the MCP server registry.

---

## Relationship to Already-Shipped agent-mcp Features

Two tactical runtime features already exist in agent-mcp and are on this plan's **removal path**
(`SCOPE.md` → "Ad-hoc Policy in Agent Frontmatter"):

- `claudecli` provider `allowedBuiltinTools` (built-in denylist), and
- `claudecli` provider `systemPromptIsAgentSpec` (let Claude internally parse an agent-md `tools:`
  header; written 2026-06-22).

These are the runtime execution path the compiler's output would eventually feed into. They are not
wasted by the registry — but the registry's `AGENT_TOOL` + `TOOL_PLATFORM_BINDING` is the strategic
replacement for the *declaration* half, and these should be reconciled (not left as a competing
third tool-permission model) when the agent-mcp refactor lands.

---

## Recommended Handoff

1. Treat `@adhd/agent-tool-registry` + `PROVIDER_TOOL_FORMAT` as the canonical design for tool
   **declaration** — do not build a separate per-provider prefix interface in agent-mcp.
2. Scope the agent-mcp side narrowly as a **runtime** change (BACKLOG FEAT-007): make
   `ProviderAdapter` implementations forward compiled platform tools, starting with the cheap win —
   Anthropic server-side `web_search` / `code_execution` (emit type-tagged entries; no local
   executor needed). Gate currently-unsupported natives (OpenAI built-ins, Anthropic client-exec
   tools) behind an explicit, actionable error rather than silent no-ops.
3. When seeding the tool catalog, add `invocation_note` / `PROVIDER_TOOL_FORMAT` entries for the
   three tricky cases above so the compiler and runtime agree on how each native tool is emitted.

---

## See Also

- `SCOPE.md` — "What This Plan Does Not Do" (runtime execution engine is agent-mcp's), "ProviderAdapter Interface"
- `DATA_MODEL.md` — Domain 2 (Tool Registry), Domain 2b (Provider Registry)
- `SEED_DATA.md` §5–6 — Platforms, Canonical Tools + Platform Bindings
- `packages/ai/agent-mcp/BACKLOG.md` — **FEAT-007** (runtime wiring; operational tracking)
- `packages/ai/agent-mcp/src/providers/anthropic.ts` — `toAnthropicTools()` (the concrete runtime gap)
