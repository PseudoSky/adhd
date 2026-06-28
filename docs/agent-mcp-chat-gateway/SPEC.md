# SPEC — agent-mcp Chat Gateway (OpenAI-compatible facade + session-aware client)

> Status: **draft / design.** Exposes agent-mcp **agents as chat models** so any chat UI
> can use agent-mcp as the underlying chat provider — with full agent-mcp fidelity
> (server-side sessions, tools, sub-agent delegation, HITL, working memory, budget/policy).
>
> Supersedes the loose discussion in `docs/mcp-env/`-era notes. Builds on the existing
> `@adhd/agent-mcp` HTTP/SSE server (`src/streaming/sse-server.ts`) and the
> agent/session/task/result stores.

---

## 1. Core principle (the one that drives every decision)

**agent-mcp's session store is the system of record for a conversation** — its message
history, working memory, tool-loop state, HITL resume tokens, and per-session cost all
live in the session. The gateway is a **thin translator**, not a history manager:

> A chat request carries the full transcript (every UI resends it). The gateway **ignores
> all but the new turn** and forwards it to the bound agent-mcp session via `task()`. The
> agent-mcp orchestrator runs the **entire** loop (provider call → tool calls → sub-agent
> delegation → repeat) server-side and returns a **final** answer. The UI sees only
> assistant text — it never needs function-calling support, and never owns the canonical
> history.

Two consequences that resolve the earlier confusion:
- **Tool use "just works" with dumb UIs** — because we run the loop and emit only the
  final response; the UI is never asked to execute a tool.
- **Resumable server-side sessions are real** — because agent-mcp already persists them;
  the gateway just needs to bind a conversation to a session id.

---

## 2. Two tiers (don't conflate them)

| Tier | Front end | What it unlocks |
|---|---|---|
| **T1 — drop-in** | Any OpenAI-/Ollama-compatible chat UI (Open WebUI, LibreChat, Jan, LM Studio, LobeChat, …) | Full *functional* agent-mcp fidelity **per conversation** — sessions, tools, delegation, HITL, memory, budget. History display is the UI's own mirror. |
| **T2 — full-fidelity** | A small purpose-built **session-aware** web client we ship (or a Responses/Assistants-API-aware UI) | Everything in T1 **plus** browse agent-mcp sessions, open a session created **anywhere** (MCP tools / CLI / another client) with its history shown, and cross-client resume. |

T1 is the 95% drop-in path. T2 exists because a generic chat-completions UI structurally
**renders its own local conversation store** and never fetches history from the backend —
so surfacing externally-created sessions *with history* requires a client that reads from
agent-mcp.

---

## 2a. Standards basis & front-end stack (research-confirmed 2026-06-28)

### Wire standards our endpoint implements
| Standard | Use here | Canonical spec |
|---|---|---|
| **OpenAI Chat Completions + SSE** (`chat.completion.chunk` → `data: [DONE]`) | **base wire format** — every chat UI *and* TS UI lib speaks it; serve this first | https://platform.openai.com/docs/api-reference/chat |
| **OpenAI `/v1/models`** | agents-as-models list | https://platform.openai.com/docs/api-reference/models |
| **OpenAI Responses API** (`previous_response_id`) | stateful upgrade — native fit for our sessions; add *after* the base | https://openai.com/index/responses-api/ |
| **Ollama `/api/chat` + `/api/tags`** | optional — Open WebUI-native | https://github.com/ollama/ollama/blob/main/docs/api.md |
| **MCP** | already served by agent-mcp (`@modelcontextprotocol/sdk`) | https://spec.modelcontextprotocol.io/ |

*Not* adopted as our base: the **Vercel AI SDK data-stream protocol** and **AG-UI** are
vendor-specific (AG-UI is CopilotKit-proprietary / unverified) — relevant only if a chosen
front-end lib requires them.

### One endpoint, swappable front ends
The same OpenAI-Chat-Completions endpoint serves **both** delivery paths, so the gateway is
built **once** and the UI is interchangeable:
- **Path A — plug into an OSS chat app:** **LibreChat** (fit 4/5, MIT) is the reference;
  **Open WebUI** (3/5) the backup. *(Dify ruled out — it owns the agent loop and competes
  with agent-mcp rather than fronting it.)* Instant chat; session binding via a templated
  header (§6). ≈ the **90%**.
- **Path B — build our own configurable UI:** **`assistant-ui`** (MIT, headless primitives:
  tool-call rendering, **inline human-approvals = our HITL**, themeable
  `Thread`/`Message`/`Composer`) for the chat surface **+ `shadcn/ui`** for the management
  panels (agents / providers / policies / budgets / usage). A *thin* custom app, not a full
  system. ≈ the unique **10%** (management UI + rich tool-use rendering). *(Alt: Vercel AI
  SDK UI `@ai-sdk/react` if Next.js/hooks preferred, but it leans on its own stream protocol.)*

### agent-mcp is the loop; the gateway is a thin translator
**Do not** adopt a second agent framework server-side (Vercel AI SDK server loop, MCP
middleware, etc.) — agent-mcp already owns the provider loop, tools, delegation, and
sessions. **And do not add a new web framework** — agent-mcp already runs an HTTP server:
`streaming/sse-server.ts` is plain **`node:http`** (`http.createServer`, manual routing,
`text/event-stream` + keep-alive; raw `node:http` was a deliberate choice, see the comment
in `server.ts`). The gateway is *only* a translator: **additional route branches on that
existing `node:http` server**, mapping Chat-Completions ⇄ `task`/`result`/session and
calling the in-process stores/orchestrator directly. No Hono/Express/Fastify, no extra
process, no self-MCP hop. (A second web *or* agent framework would both be needless — the
same reason Dify is out.)

---

## 3. Architecture & data flow

```
                    ┌─────────────────────── agent-mcp Chat Gateway ───────────────────────┐
 chat UI ──HTTP──►  │  /v1/chat/completions                                                 │
 (model+history)    │    1. resolve AGENT      ← model field ("deepseek", "claude-oauth")   │
                    │    2. resolve SESSION     ← header / model#suffix / prefix-fingerprint │
                    │    3. extract DELTA       ← last user message only (ignore the rest)   │
                    │    4. dispatch            ← task(session, delta)  OR  taskResume(token) │
                    │                              if the session is awaiting_input (HITL)    │
                    │    5. stream              ← orchestrator's final answer as SSE chunks   │
                    └───────────────────────────────────┬───────────────────────────────────┘
                                                         │ in-process / MCP
                    ┌────────────────────────────────────▼──────────────────────────────────┐
                    │  agent-mcp: AgentStore · SessionStore (HISTORY OF RECORD) · Orchestrator │
                    │  provider call → MCP tool calls → sub-agent delegation → loop → final    │
                    │  + policy · budget · HITL suspend/resume · usage/cost · working memory   │
                    └──────────────────────────────────────────────────────────────────────────┘
```

Implementation: **extend agent-mcp's existing `node:http` server** (`streaming/sse-server.ts`)
with `/v1/*` route branches — **always served** alongside the existing `/tasks/:id/stream`
(the SSE server already starts by default; **no opt-in flag, not hidden**) — calling the
in-process `AgentStore`/`SessionStore`/`Orchestrator` directly. **No new framework, no
separate process, no self-MCP hop.** The existing server already does `text/event-stream` +
15s keep-alive + task **event-bus** subscription — the exact streaming substrate
chat-completions needs, so we reuse it rather than rebuild it.

---

## 4. Endpoints

### 4.1 OpenAI-compatible (the drop-in surface)
| Method · path | Purpose | Notes |
|---|---|---|
| `GET /v1/models` | List agent-mcp agents as selectable "models" | one row per agent; `id`=agent name |
| `POST /v1/chat/completions` | Chat turn (stream + non-stream) | the core; session-canonical delta forward |
| `GET /v1/models/{id}` | Agent/model detail | optional |

### 4.2 Ollama-compatible (optional — Open WebUI native)
| `GET /api/tags` | List agents (Ollama model shape) | mirrors `/v1/models` |
| `POST /api/chat` | Chat turn | mirrors chat/completions |

### 4.3 Session API (T2 — the full-fidelity surface)
| `GET /sessions?agent=` | List agent-mcp sessions (the user's) | for the session browser |
| `POST /sessions` | Create a session for an agent | returns session id |
| `GET /sessions/{id}/messages` | **Load history from agent-mcp** | the thing generic UIs can't do |
| `POST /sessions/{id}/messages` | Post a turn by explicit session id | clean stateful path; streams reply |
| `DELETE /sessions/{id}` | Close/forget a session | maps to `session_close` |

### 4.4 Stateful-standard (optional, strategic)
`POST /v1/responses` (OpenAI **Responses API**) — its server-side `previous_response_id`
maps 1:1 to an agent-mcp session. Best long-term fit for thread-aware UIs as they adopt it.

### 4.5 Ops
`GET /healthz`, `GET /v1` (capabilities), auth on all (§9).

---

## 5. Agent ↔ "model" mapping
- **`model` = agent name.** `/v1/models` enumerates `AgentStore.list()`; adding an agent
  makes it selectable (UIs that cache the list need a refresh).
- **Session-in-model convention** (for UIs that can't send headers): `model = "<agent>#<sessionId>"`.
  Bare `<agent>` → new/fingerprinted session; `<agent>#<id>` → that exact session.
- *(Optional)* virtual models, e.g. `<agent>@stateless` to force per-request ephemeral runs.

---

## 6. Session binding (the heart of it)
Resolution order for "which agent-mcp session is this conversation?":
1. **Explicit id (PRIMARY — research-confirmed turnkey)** — a stable per-conversation id in
   a templated request header **or** a `model#sessionId` suffix. The top OSS UIs already send
   one with no fork:
   - **LibreChat**: `headers: { X-AgentMcp-Session: "{{LIBRECHAT_BODY_CONVERSATIONID}}" }` in a `librechat.yaml` custom endpoint.
   - **Open WebUI**: `X-AgentMcp-Session: {{CHAT_ID}}` in per-connection custom headers (`{{CHAT_ID}}` is stable per conversation; src `backend/open_webui/utils/headers.py`).
2. **Prefix fingerprint (FALLBACK)** — stable hash of the conversation's immutable prefix
   (system + first user message[s], namespaced by auth/`user`). A *lookup key* into the
   session map — **not** history reconstruction. Only for UIs that can't send a header.
3. **None matched** → create a session, seed it from the request's history once (cold
   start), and return its id (via response `id` / a header) for clients that can reuse it.

All bindings resolve through the **persisted `session_aliases` index (§6a)** — durable
across restarts; the in-memory map from P0 is only a hot cache in front of it.

**Delta extraction:** forward only the trailing new user message; the prior transcript is
ignored for content (agent-mcp has it). The resent transcript is used **only** to rehydrate
a session that the gateway has lost (facade restart) — a resilience fallback, never canon.

**No double-context:** because we forward the delta into a session that already holds the
history, context isn't duplicated; `AGENT_MCP_CONTEXT_LIMIT` governs windowing inside agent-mcp.

---

## 6a. Session addressing, ownership & provenance (persisted)

The conversation→session binding is **persisted on agent-mcp's side**, not held in gateway
process memory — so it survives restarts (deploy / crash / `/mcp` reload). The in-memory
`Map` from P0 becomes only a hot cache in front of this.

**It's a session *alias index*, not an "external conversation id."** A LibreChat
`conversationId`, an OpenAI **Responses** `previous_response_id`, and an Assistants
`thread_id` are the *same* concept — an external handle that resolves to one session. One
table serves them all (and any future stateful protocol with zero new schema):

```sql
session_aliases(
  session_id  TEXT,    -- → sessions.id
  scheme      TEXT,    -- "conversation" | "response" | "thread" | "external"
  namespace   TEXT,    -- owner / auth subject (caller-controlled ids must be scoped)
  value       TEXT,    -- the external handle
  created_at  TEXT,
  UNIQUE(scheme, namespace, value)          -- + index for per-request lookup
)
```
- Gateway today writes `scheme="conversation"` (e.g. the LibreChat id), namespaced by owner.
- Responses/Assistants later write `scheme="response"` / `"thread"` — same mechanism, no new schema.
- Many aliases → one session (a session reachable from several surfaces).
- Lookup: `findSessionByAlias(scheme, namespace, value)`; the gateway records the alias on session create.

**Plus two first-class session columns** the management console + multi-user need (in the
*same* migration, not bolted on later):
- **`owner` / `user_id`** — authz + the console's "my sessions"; the alias `namespace` keys
  off it. 1:1 → a column, not an alias.
- **`origin`** — how the session was created: `gateway:librechat`, `mcp`, `cli`, `console`,
  `delegation`. Provenance for the console to filter/group by.
- *(optional)* **`title`/`label`** — display name for natively-created sessions (MCP/CLI/console)
  with no UI-generated title.

**Deliberately NOT folded in** (different lifecycles): **idempotency keys** (turn-retry
dedupe → task-scoped, TTL'd), **delegation lineage** (parent↔sub-agent session → an internal
FK), and **arbitrary metadata** (→ a `metadata` JSON column if ever needed). None belong in
the alias index, which needs its uniqueness/index guarantees.

---

## 7. Customized behaviors (what differs from a plain model endpoint)

- **Server-side tool/delegation loop** — the orchestrator executes MCP tools and sub-agent
  delegation internally; the UI receives one final assistant message. No `tool_calls`
  surface; no UI function-calling required. *(Optional: stream tool activity as status /
  `reasoning` deltas, off by default.)*
- **HITL as chat turns** — if a task suspends on `request_human_input`, the gateway ends the
  assistant turn with the agent's **question**; the user's next message is detected (session
  in `awaiting_input`) and routed via `taskResume(token)` instead of a new task. HITL — which
  no plain model endpoint can do — becomes ordinary chat back-and-forth.
- **System prompt precedence** — the agent's own `systemPrompt`/compiled prompt is
  authoritative. A UI-sent `system` message is **appended as supplementary context** by
  default (configurable: append | ignore | override). For `sk-ant-oat` agents the Claude
  Code identity block is enforced regardless (existing adapter behavior).
- **Sampling params** (`temperature`, `max_tokens`, …) — the **agent config wins** by default
  to keep agents deterministic; per-request overrides honored only if in an opt-in allowlist.
- **Budget / policy** — a task blocked by policy or a budget cap returns a normal assistant
  message (the error/refusal text) + an error finish-reason, rather than a transport error.
- **Cancellation** — client disconnect / stop → `task_cancel`. Honest caveat: cancellation is
  observed after the in-flight tool batch settles (agent-mcp **DEBT-003**), so stop latency
  can be one tool-batch long.

---

## 8. Streaming
SSE `chat.completion.chunk` deltas. During long server-side tool loops, emit SSE keep-alive
comments (and optional tool-status events) so UIs don't time out before the first token.
Non-streaming mode buffers to a single `chat.completion`.

---

## 9. Auth & multi-user
- A gateway API key (bearer) gates all endpoints; the key (or an auth subject) **namespaces
  sessions and fingerprints** so different users never collide on a shared deployment.
- agent-mcp's `ADHD_AGENT_ENV_ALLOWLIST` env-name guard and per-agent provider secrets are
  unchanged — the gateway adds no new secret surface (it never sees provider keys; agents do).

---

## 10. Feature support matrix (annotated)

**Legend:** ✅ supported · 🔧 supported via custom agent-mcp behavior (see note) · ⚠️ partial/conditional · ❌ not in v1

| Chat feature | T1 generic UI | T2 session client | Behavior / customization |
|---|---|---|---|
| Model picker → **select agent** | ✅ | ✅ | 🔧 a "model" is a full agent (provider + prompt + tools + policy + budget), via `/v1/models` |
| Streaming responses | ✅ | ✅ | 🔧 SSE chunks + keep-alives during server-side tool loops |
| Multi-turn conversation | ✅ | ✅ | 🔧 history lives in the agent-mcp **session**, not the request |
| **Server-side** session persistence/resume | ✅ | ✅ | 🔧 session is system of record; survives gateway restart; rehydratable from resent history |
| Cross-client / cross-surface resume **with history shown** | ❌ | ✅ | 🔧 generic UIs render their own store; T2 loads via `GET /sessions/{id}/messages` |
| Browse / list existing sessions | ❌ | ✅ | T2 session browser (`GET /sessions`) |
| Tool / function calling | ✅ | ✅ | 🔧 **server-side loop**; UI never sees `tool_calls`, needs no function-call support |
| Sub-agent delegation | ✅ | ✅ | 🔧 agent-mcp recursion; invisible; collapses to one assistant reply |
| **HITL** (agent asks the human) | ⚠️ | ✅ | 🔧 question → assistant turn; user reply → `taskResume`; T1 works while the same conversation continues |
| Working-memory / long-context handling | ✅ | ✅ | 🔧 `AGENT_MCP_CONTEXT_LIMIT` + session memory; no double-context (delta-forward) |
| Token usage per response | ✅ | ✅ | populated in the `usage` field from agent-mcp telemetry |
| Per-session cost / budget caps | ⚠️ | ✅ | 🔧 `usage_query` aggregate (T2 surfaces it); budget plugin can cap → refusal message |
| Policy enforcement | 🔧✅ | 🔧✅ | blocked task → normal assistant error message + error finish-reason |
| Stop / cancel generation | ⚠️ | ✅ | 🔧 disconnect → `task_cancel`; latency ≤ one tool-batch (DEBT-003) |
| Regenerate last turn | ⚠️ | ✅ | 🔧 re-runs the last turn as a new task on the session |
| Edit earlier message / branch | ⚠️ | ✅ | 🔧 changes conversation identity; T1 fingerprint → branched session (old GC'd); T2 explicit branch |
| Switch agent/provider mid-conversation | ⚠️ | ✅ | 🔧 new `model` on the same session; history carries; provider/tools change for subsequent turns |
| Temperature / sampling params | ⚠️ | ⚠️ | 🔧 agent config authoritative; per-request overrides only via opt-in allowlist |
| System prompt / custom instructions | 🔧 | 🔧 | agent prompt authoritative; UI `system` appended (configurable append/ignore/override) |
| Vision / image input | ⚠️ | ⚠️ | pass-through **iff** the agent's provider is vision-capable (openai/anthropic) |
| File attachments | ❌ | ❌ | v2 — map to message content / a retrieval tool |
| Embeddings | ❌ | ❌ | not agent-mcp's role |
| Conversation title generation | ✅ | ✅ | UI issues a normal chat request; works unchanged |
| Show "thinking" / tool steps | 🔧 | 🔧 | optional streamed tool-status / `reasoning` deltas; **off by default** (clean final answer) |
| Parallel tool calls | ✅ | ✅ | 🔧 agent-mcp `Promise.all` internally; invisible to UI |
| Provider retries / rate-limit handling | ✅ | ✅ | agent-mcp `retryConfig`; surfaced as error if exhausted |
| Dynamic model list refresh | ✅ | ✅ | new agents appear on `/v1/models` refetch (some UIs cache → manual refresh) |
| Multi-user isolation | ✅ | ✅ | 🔧 sessions/fingerprints namespaced by API key / auth subject |
| API-key auth | ✅ | ✅ | bearer on the gateway; agents hold provider secrets, gateway never does |

---

## 11. UI compatibility (where each tier lands)

| Front end | T1 drop-in | T2 full-fidelity |
|---|---|---|
| Open WebUI | ✅ (OpenAI or Ollama endpoint) | needs custom/Responses |
| LibreChat | ✅ (custom OpenAI endpoint) | needs custom/Responses |
| Jan / LM Studio client / LobeChat / NextChat / Chatbox | ✅ | — |
| **Our session-aware web client** (ship in T2) | ✅ | ✅ all rows |
| Responses/Assistants-thread-aware UI (as they mature) | ✅ | ✅ (server threads) |

---

## 12. Phasing
- **P0 — `/v1/*` routes on the existing `node:http` server:** add `GET /v1/models` + `POST /v1/chat/completions` (SSE) branches to `streaming/sse-server.ts` (no new dependency), **served by default** (the SSE server already starts — no flag, not hidden); agents-as-models, **explicit `X-AgentMcp-Session` header binding** (fingerprint fallback), delta-forward, one HITL round-trip; in-process stores/orchestrator. **Validate against a real LibreChat** custom endpoint (reference Path-A UI); Open WebUI secondary.
- **P1 — persist session binding + harden:** the headline item is **durable session addressing (§6a)** — add the `session_aliases` table + `sessions.owner`/`origin` (migration), replace the in-memory `Map` with `findSessionByAlias` (Map kept only as a hot cache), namespaced by owner; **test: a binding survives a server restart** (reopen → same conversation id resolves to the same session). Plus: `model#id` override, cancellation (`task_cancel` on disconnect), usage in `usage`, keep-alives during long tool loops, docs.
- **P2 — Path B (build-our-own) + session API:** `/sessions*` endpoints + a thin **`assistant-ui` + `shadcn/ui`** client (chat with tool-call/HITL rendering · session browser: list / open-with-history / continue / branch · management panels: agents/providers/policies/budgets/usage). Optional Ollama endpoints.
- **P3 — Responses API** for thread-aware UIs; optional tool-status streaming; vision pass-through.

---

## 13. Tests (real-seam, per repo CLAUDE.md §6)
- Drive the gateway with a **real HTTP client** against the **running** agent-mcp (real DB,
  real provider) — assert: model list = agents; a 3-turn conversation persists in the
  **agent-mcp session** (reopen the session store, history present); tools fire server-side
  (final answer reflects a tool result) with the UI never receiving `tool_calls`; a HITL
  agent suspends → question returned → next turn resumes via the token; budget cap → refusal.
- **Negative controls:** drop the delta-forward (resend full history) → assert double-context
  is detected/avoided; revert session binding → assert turns land in the wrong/ new session.
- **Drop-in proof:** point a real Open WebUI/LibreChat instance at the gateway and complete a
  multi-turn tool-using conversation (documented, env-gated only if it needs a paid model).

---

## 14. Open decisions
1. **Default system-message policy** — append (recommended) vs ignore vs override.
2. **Fingerprint vs require explicit id** — ship fingerprint fallback (recommended for
   drop-in) or require `model#id`/header (stricter, fewer surprises on edit/branch)?
3. **Sampling-param override allowlist** — which (if any) per-request params may override agent config.
4. **Stateless escape hatch** — support `<agent>@stateless` for pure per-request runs?
5. **Tool-status streaming** — default off (clean) vs a standard "reasoning" channel.
6. **Responses API priority** — build in P3 or defer until a target UI needs it.
