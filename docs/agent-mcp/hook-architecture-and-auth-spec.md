# Spec: Transport & Protocol Hook Layers + Pluggable Auth for `@adhd/agent-mcp`

**Status:** DRAFT / design spec (not yet implemented)
**Target:** `@adhd/agent-mcp` ≥ 2.2.0 (additive; no breaking change to existing plugins)
**Motivation:** agent-mcp can run remotely over the `http` (Streamable HTTP) transport, but the
HTTP handler forwards every request straight to `httpTransport.handleRequest(req, res)` with **no
authentication**, and the plugin/hook system has **no seam** at which auth could be enforced. This
spec defines the *correct*, symmetric pre/post hook taxonomy across all three lifecycle layers so
that authentication and authorization (and any transport/protocol concern: rate limiting, audit
logging, tracing, quota) can be modeled as first-class plugins — not bolted on as a patch.

---

## 1. The problem, precisely

The current hook system (`@adhd/agent-base-types/src/hooks.ts`) fires **only** in the
agent-orchestration lifecycle, which is *downstream* of the transport and the MCP protocol handler:

| Layer | Where (code) | Hooked today? |
|---|---|---|
| **A. Transport** | `server.ts:761` — `createHttpServer(async (req,res)=>httpTransport.handleRequest(req,res))` | **No** |
| **B. Protocol / RPC method** | `server.ts` `setRequestHandler(ListToolsRequestSchema…)` (`:445`), `CallToolRequestSchema` (`:540`), plus `initialize` | **No** |
| **C. Orchestration** | orchestrator loop — `pre:model_request`, `pre:tool_call`, `post:tool_call`, … | **Yes** |

Consequences that make auth-as-a-plugin impossible *as designed*:

1. **No hook sees the request.** Hook payloads carry `executionContext`/`messages`/`tools`/
   `tokenUsage`, never the raw `req`/headers. A plugin has no credential to check.
2. **Identity isn't threaded inward.** `ExecutionContext` (`domain.ts:303`) has
   `taskId/sessionId/agentName/…` but **no principal**. Even a `pre:tool_call` enforcement plugin
   sees an anonymous caller.
3. **`initialize` / `tools/list` bypass orchestration entirely.** They are answered at Layer B and
   never reach Layer C, so no orchestration hook can gate the protocol handshake or discovery.

## 2. Design principles

1. **Symmetric pre/post at every layer.** Each layer gets a *pre* hook (can block — "enforcement")
   and a *post* hook (observational — for audit/metrics/tracing). This is the "correct hooks, not a
   patch" requirement.
2. **Authenticate once, authorize per-call.** AuthN happens at the transport edge (Layer A) and
   establishes a `Principal`; authZ happens per protocol method (Layer B) and, if desired, per tool
   execution (Layer C).
3. **Transport-uniform.** The same authZ hook (`pre:rpc`) fires for both `stdio` and `http`; only
   AuthN differs (http reads a header, stdio yields an implicit local principal).
4. **Additive & back-compatible.** New events extend `HookEventMap`; existing plugins
   (budget, sanitize) and the existing `Plugin.install(hooks)` contract are untouched.
5. **Fail closed on the pre hooks, never swallow.** Enforcement hooks propagate typed errors; the
   transport/protocol layer maps them to the correct wire response (HTTP 401/403, JSON-RPC error).
6. **Reuse the existing machinery.** The same `IHookRegistry`, `registerEnforcement`/`enforce`
   pattern, plugin loader, and `agent-mcp.config.json` plugin block. No new plugin-loading concept.

---

## 3. The full hook taxonomy

### 3.1 New events (this spec)

| Event | Layer | Kind | Transports | Fires |
|---|---|---|---|---|
| `pre:request` | A | **enforcement** | http | Per raw HTTP request, **before** `handleRequest`. AuthN. Throw → 401. |
| `post:request` | A | observational | http | After the HTTP response is written. Audit/metrics. |
| `connection:opened` | A | **enforcement** | http, stdio | Per transport connection (http session id / stdio process start). Establishes connection-scoped principal; stdio sets the local principal here. Throw → reject connection. |
| `connection:closed` | A | observational | http, stdio | Connection teardown. |
| `pre:rpc` | B | **enforcement** | http, stdio | Before every MCP method handler (`initialize`, `tools/list`, `tools/call`, `resources/*`, …). AuthZ. Throw → JSON-RPC error (401/403). |
| `post:rpc` | B | observational | http, stdio | After the method handler returns a result or error. Audit. |

### 3.2 Existing events (unchanged; Layer C)

`task:start`, `pre:model_request`\*, `post:model_response`, `pre:tool_call`\*, `post:tool_call`,
`transform:tool_result`, `message:appended`, `task:completed|failed|cancelled`,
`session:created`, `agent:mutated`. (\* = already enforcement events.)

### 3.3 Payload interfaces (add to `hooks.ts`)

```ts
/** A resolved caller identity. Established at Layer A, threaded through B → C. */
export interface Principal {
  /** Stable id — token subject, mTLS CN, api-key id, or "local" for stdio. */
  id: string;
  /** Coarse identity source. */
  kind: 'anonymous' | 'local' | 'token' | 'mtls' | 'custom';
  /** Authorization scopes/roles this principal holds (authz plugins interpret these). */
  scopes: string[];
  /** Free-form verified claims (e.g. token payload). Never trust unverified input here. */
  claims?: Record<string, unknown>;
  /** Which transport minted this principal. */
  transport: 'stdio' | 'http';
}

/** Layer A — raw HTTP request (http transport only). `principal` is an OUT slot. */
export interface PreRequestPayload {
  transport: 'http';
  method: string;                 // HTTP method
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  remoteAddress?: string;
  /** Set by an authn handler; read by the transport after enforce() returns. */
  principal?: Principal;
}
export interface PostRequestPayload {
  transport: 'http';
  method: string;
  url: string;
  status: number;
  durationMs: number;
  principal?: Principal;
}

/** Layer A — connection lifecycle. `principal` is an OUT slot for stdio/local establishment. */
export interface ConnectionOpenedPayload {
  transport: 'stdio' | 'http';
  connectionId: string;           // http: Mcp-Session-Id; stdio: process-scoped uuid
  remoteAddress?: string;
  principal?: Principal;
}
export interface ConnectionClosedPayload {
  transport: 'stdio' | 'http';
  connectionId: string;
  durationMs: number;
  reason?: string;
}

/** Layer B — one JSON-RPC method invocation. */
export interface PreRpcPayload {
  method: string;                 // 'initialize' | 'tools/list' | 'tools/call' | …
  /** For 'tools/call', the tool name (e.g. 'agent_delete'); else undefined. */
  toolName?: string;
  params: unknown;
  principal: Principal;           // never undefined here — Layer A guarantees at least anonymous
  connectionId: string;
  requestId: string | number | null;
}
export interface PostRpcPayload extends PreRpcPayload {
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}
```

### 3.4 `HookEventMap` additions

```ts
export interface HookEventMap {
  // … existing …
  'pre:request': PreRequestPayload;
  'post:request': PostRequestPayload;
  'connection:opened': ConnectionOpenedPayload;
  'connection:closed': ConnectionClosedPayload;
  'pre:rpc': PreRpcPayload;
  'post:rpc': PostRpcPayload;
}

// Extend the set of events whose handlers may block:
export type EnforcementEvent =
  | 'pre:model_request'
  | 'pre:tool_call'
  | 'pre:request'        // NEW — authn
  | 'connection:opened'  // NEW — connection admission
  | 'pre:rpc';           // NEW — authz
```

`IHookRegistry` is unchanged in shape — `registerEnforcement`/`enforce` already generalize over
`EnforcementEvent`, so widening the union is the only type change.

---

## 4. Enforcement semantics & typed errors

Mirror the existing `IEnforcementError` / `IToolWarning` marker pattern (`hooks.ts:98`,`113`):

```ts
export interface IAuthnError {           // thrown from pre:request / connection:opened
  readonly isAuthnError: true;
  readonly status: 401;
  readonly wwwAuthenticate?: string;     // e.g. 'Bearer realm="agent-mcp"'
  readonly message: string;
}
export interface IAuthzError {           // thrown from pre:rpc
  readonly isAuthzError: true;
  readonly status: 403;
  readonly rpcCode: number;              // JSON-RPC error code, e.g. -32001
  readonly message: string;
}
```

**Wire mapping (who catches what):**

| Thrown from | Caught by | Response |
|---|---|---|
| `pre:request` (`IAuthnError`) | http handler (`server.ts:761`) | HTTP `401` + `WWW-Authenticate`, **never** calls `handleRequest` (no MCP session created) |
| `connection:opened` (`IAuthnError`) | transport connect wiring | connection refused / closed |
| `pre:rpc` (`IAuthzError`) | RPC dispatch wrapper (Layer B) | JSON-RPC error object with `rpcCode`; for http also sets HTTP `403` |
| existing `IEnforcementError`/`IToolWarning` | orchestrator (unchanged) | task failure / tool-warning (unchanged) |

**Observational hooks never throw** (contract already stated in `hooks.ts:96`). `post:*` handler
exceptions are swallowed by `emit()` and logged.

---

## 5. Principal threading (the load-bearing part)

The whole point is that identity established at the edge is visible everywhere downstream.
**The MCP SDK already provides the carrier — we build on it rather than inventing a parallel store.**

> **SDK-native mechanism (verified against `@modelcontextprotocol/sdk@1.29.0`):**
> `StreamableHTTPServerTransport.handleRequest` reads `const authInfo = req.auth`
> (`dist/cjs/server/streamableHttp.js:134`) off the incoming Node request and threads it into the
> per-request `extra` as `extra.authInfo` (`dist/cjs/shared/protocol.js:353`), delivered to **every**
> request handler. So the SDK's designed seam is: *an HTTP-layer step sets `req.auth`; every handler
> then receives it as `extra.authInfo`.* Our `Principal` is carried as this `AuthInfo`
> (`{ token, clientId?, scopes, expiresAt?, extra }`), with our richer fields under `authInfo.extra`.

1. **Establish** — Layer A. The `pre:request` enforcement handler authenticates and sets
   `payload.principal`; the http handler then assigns it to **`req.auth`** *before* calling
   `handleRequest`. If no handler sets it, substitute `ANONYMOUS` (`{id:'anonymous',
   kind:'anonymous',scopes:[],transport:'http'}`), or reject with 401 when `required`. For stdio,
   `connection:opened` sets the `LOCAL` principal (`{id:'local',kind:'local',scopes:['*'],
   transport:'stdio'}` — configurable; see §7); it is stashed once and injected as `authInfo` on the
   stdio request path.
2. **Carry** — no custom store needed: the SDK propagates `req.auth` → `extra.authInfo` to every
   method handler. The Layer B `pre:rpc` wrapper reads `extra.authInfo` as the principal.
3. **Propagate to orchestration** — add an optional field to `ExecutionContext` (`domain.ts:303`),
   populated from `extra.authInfo` where the `task`/`agent` tool handlers build the context:

   ```ts
   export interface ExecutionContext {
     // … existing …
     /** Caller identity for the request that spawned this task (undefined for internal/system). */
     principal?: Principal;
   }
   ```

   Populated where the `task`/`agent` tool handlers build the `ExecutionContext`, from the
   request-scoped principal. Delegated child tasks inherit the parent's principal unless a policy
   says otherwise. This lets existing `pre:tool_call` plugins do **per-execution** authz
   (e.g. "principal X may run tools but not shell") on top of the per-method authz at Layer B.

---

## 6. Wiring points (what the entrypoint/engine must call)

The `IHookRegistry` instance is already created at startup and handed to the server via
`ServerDeps.hooks` (`server.ts:92`) and to the orchestrator. Layers A/B just need to *invoke* it.

**Layer A — `server.ts` http handler (currently `:761`):**
```ts
const httpServer = createHttpServer(async (req, res) => {
  const pre: PreRequestPayload = { transport:'http', method:req.method!, url:req.url!,
    headers:req.headers, remoteAddress:req.socket.remoteAddress };
  const started = nowMs();
  try {
    await hooks.enforce('pre:request', pre);           // throws IAuthnError → 401
  } catch (e) {
    if (isAuthnError(e)) { res.writeHead(401, e.wwwAuthenticate ? {'WWW-Authenticate':e.wwwAuthenticate}:{}).end(e.message); 
      void hooks.emit('post:request', {…, status:401, durationMs:nowMs()-started}); return; }
    throw e;
  }
  (req as any).auth = pre.principal ?? ANONYMOUS('http');   // SDK-native carrier: transport threads to extra.authInfo
  await httpTransport.handleRequest(req, res);
  void hooks.emit('post:request', {…, status:res.statusCode, durationMs:nowMs()-started, principal:pre.principal});
});
```
The stdio path emits `connection:opened` once at startup (establishing `LOCAL`/configured principal)
and `connection:closed` on shutdown.

**Layer B — RPC dispatch, uniformly (including `initialize`).** The gating wrapper must cover every
method, *including the handshake* that the SDK registers internally. Verified seam: `Server` calls
`this.setRequestHandler(InitializeRequestSchema, …)` **in its own constructor**
(`sdk/server/index.js:52`), so a `Server` **subclass that overrides `setRequestHandler` intercepts
initialize via dynamic dispatch** — `this.setRequestHandler` inside the super-constructor resolves to
the subclass override. One subclass therefore wraps `initialize`, `ping`, `tools/list`,
`tools/call`, and any `resources/*` with a single guard — no per-schema registration, no reaching
into the private `_requestHandlers` map:

```ts
class GuardedServer extends Server {
  constructor(info, opts, private hooks: IHookRegistry) { super(info, opts); }
  setRequestHandler(schema, handler) {
    const method = schema.shape.method.value;               // e.g. 'initialize', 'tools/call'
    return super.setRequestHandler(schema, async (req, extra) => {
      const principal = (extra?.authInfo as Principal) ?? ANONYMOUS(transportOf(extra));
      const p: PreRpcPayload = { method, toolName: method==='tools/call'? req.params?.name : undefined,
        params: req.params, principal, connectionId: extra?.sessionId ?? 'stdio', requestId: req.id ?? null };
      const t = nowMs();
      await this.hooks.enforce('pre:rpc', p);                // throws IAuthzError → JSON-RPC error
      try { const r = await handler(req, extra); void this.hooks.emit('post:rpc', {...p, ok:true, durationMs:nowMs()-t}); return r; }
      catch (e) { void this.hooks.emit('post:rpc', {...p, ok:false, errorCode:codeOf(e), durationMs:nowMs()-t}); throw e; }
    });
  }
}
```
Note the principal arrives via **`extra.authInfo`** (the SDK-native carrier from §5), so Layer B
needs no custom lookup. `initialize` can be allow-listed pre-auth in the plugin's `methodScopes` so
clients can still negotiate; everything else is gated.

**Loader — no change.** Plugins still `install(hooks)` and call
`hooks.registerEnforcement('pre:rpc', …)`. The server just constructs `GuardedServer` instead of
`Server` and sets `req.auth` in the http handler (§6 Layer A). *(The `schema.shape.method.value`
accessor for the method name is a zod-schema detail to confirm against the SDK's exported request
schemas during implementation, but the subclass-override seam itself is verified.)*

---

## 7. Reference plugin: `@adhd/agent-mcp-plugin-auth`

A bearer-token authn + scope-based authz plugin, configured via the standard plugin block.

```jsonc
// agent-mcp.config.json
{ "plugins": [
  { "module": "@adhd/agent-mcp-plugin-auth", "config": {
      "required": true,                 // if false, unauthenticated → ANONYMOUS (no scopes)
      "allowStdio": true,               // stdio peer is trusted-local (LOCAL principal, scopes ['*'])
      "tokens": [                       // or "jwks"/"introspection" for real deployments
        { "token": "env:AGENT_MCP_ADMIN_TOKEN", "principal": "admin", "scopes": ["*"] },
        { "token": "env:AGENT_MCP_RO_TOKEN",    "principal": "readonly", "scopes": ["tools:read","usage:read"] }
      ],
      "methodScopes": {                 // authz: method/tool → required scope
        "initialize": [], "tools/list": ["tools:read"],
        "tools/call:agent_create": ["agents:write"], "tools/call:agent_delete": ["agents:admin"],
        "tools/call:task": ["tasks:run"], "tools/call:usage_query": ["usage:read"]
      }
  }}
]}
```

`install(hooks)`:
- `registerEnforcement('pre:request', authenticate)` — read `Authorization: Bearer`, timing-safe
  compare against configured tokens; set `payload.principal` or throw `IAuthnError(401)` when
  `required`. (stdio never hits this; see `connection:opened`.)
- `registerEnforcement('connection:opened', …)` — for stdio, set `LOCAL`/configured principal
  (respect `allowStdio`).
- `registerEnforcement('pre:rpc', authorize)` — resolve required scopes for
  `method` (or `tools/call:<toolName>`); throw `IAuthzError(403, -32001)` unless `principal.scopes`
  satisfies (supporting `*` and prefix wildcards). `initialize` may be allowed pre-auth so clients
  can negotiate, or gated — configurable.
- `register('post:rpc', auditLog)` + `register('post:request', accessLog)` — structured audit trail
  (principal, method, outcome, latency) via the injected logger/`db`.

The plugin is pure hook registration — **no server-source changes** once Layers A/B emit the events.

## 8. stdio vs http behavior

| | stdio | http |
|---|---|---|
| AuthN point | `connection:opened` at startup | `pre:request` per request (bearer header) |
| Default principal | `LOCAL` scopes `['*']` (single trusted local peer) — configurable to lock down | `ANONYMOUS` scopes `[]` (or 401 if `required`) |
| AuthZ point | `pre:rpc` (uniform) | `pre:rpc` (uniform) |
| Typical policy | allow all (local dev) | token required, scope-gated |

This preserves today's zero-friction local stdio experience while making remote http gate-able.

## 9. Back-compat & migration

- **Additive.** New events extend `HookEventMap`; `EnforcementEvent` widens. Existing plugins and
  the `Plugin`/`PluginContext`/`PluginFactory` contracts are byte-compatible.
- **Default-open unless configured.** With no auth plugin loaded, Layers A/B emit events with an
  `ANONYMOUS`/`LOCAL` principal and enforce nothing — identical observable behavior to today.
- **Version:** minor bump (new capability, no break) — `2.2.0`.
- **Docs:** update `architecture-and-security.md` (§ trust boundaries) and AGENTS.md once shipped.

## 10. Testing plan (also closes the "http transport untested" gap)

All default-running (per repo's live-testing mandate), driving the **real** loaded transport:

1. **http, no auth plugin** → request succeeds with `ANONYMOUS` (back-compat).
2. **http, auth `required`, no token** → `401`, `handleRequest` never invoked (assert no MCP session
   created).
3. **http, bad token** → `401`.
4. **http, valid token, allowed method** (`tools/list`) → `200` + result.
5. **http, valid RO token, forbidden method** (`tools/call:agent_delete`) → `403` / JSON-RPC error.
6. **stdio, `allowStdio:true`** → `LOCAL` principal, all methods allowed.
7. **`pre:rpc` covers the handshake** → an unauthorized `initialize`/`tools/list` is blocked
   (proves Layer B gates what orchestration hooks cannot).
8. **Principal reaches Layer C** → a `pre:tool_call` test asserts `executionContext.principal.id`
   matches the token subject.
9. **Audit** → `post:rpc` fires once per method with correct `ok`/`errorCode`/`durationMs`.

Drive these with a real `StreamableHTTPClientTransport` (http) and `StdioClientTransport` (stdio) —
the same approach already verified manually this session.

## 11. Security considerations

- `pre:request` MUST run **before** `handleRequest`, so unauthenticated callers never create MCP
  sessions or reach any tool. (Enforced by the wiring in §6.)
- Timing-safe token comparison; never log raw tokens (only principal id).
- TLS is out of scope for the transport — terminate at a proxy or extend the http server; the spec
  assumes transport confidentiality is handled at/above the socket.
- authZ default is **deny** for any method not present in `methodScopes` when `required` (fail
  closed), configurable to default-allow for gradual rollout.
- Principal `claims` must only ever hold **verified** data (post-signature-check), never raw headers.

## 12. Out of scope / future

- OAuth2/OIDC resource-server flows, JWKS rotation, token introspection (the plugin can add these;
  the hook surface already supports them).
- Per-tool argument-level authz (belongs at Layer C `pre:tool_call`, which the principal threading
  now enables — a follow-up plugin).
- Rate-limiting / quota plugin (same `pre:request`/`pre:rpc` seam; explicitly enabled by this spec).

## 13. Resolved during spike + remaining questions

**Resolved (verified against `@modelcontextprotocol/sdk@1.29.0`):**
- **`initialize`-gating seam** — RESOLVED. `Server` registers `initialize` via
  `this.setRequestHandler(InitializeRequestSchema, …)` in its constructor (`server/index.js:52`); a
  `Server` subclass overriding `setRequestHandler` intercepts it via dynamic dispatch (§6). One guard
  covers all methods, no private-field access.
- **Principal threading** — RESOLVED. Use the SDK-native `req.auth` → `extra.authInfo` path
  (`streamableHttp.js:134` → `protocol.js:353`) instead of a custom request-scoped store (§5). This
  is idiomatic and also lets us interoperate with the SDK's existing bearer/OAuth helpers later.

**Remaining (implementation-time, low-risk):**
- The `schema.shape.method.value` accessor for a request's method name — confirm against the SDK's
  exported request-schema objects (a zod-shape detail; the subclass-override seam itself is verified).
- Whether `connection:opened` should also gate http per-session (admission) in addition to per-request
  `pre:request`. Leaning: for streamable HTTP the bearer rides per request, so `pre:request` is
  authoritative; `connection:opened` stays primarily stdio + observability.
- Ship the auth plugin in-repo (`packages/agent/agent-plugin-auth`, mirroring `agent-plugin-budget`)
  vs a separate package — recommend in-repo for parity and default CI coverage.
- **Deprecated original guess:** an earlier draft proposed a custom `bindPrincipal(req, …)`
  request-scoped store; superseded by the SDK-native `req.auth`/`extra.authInfo` carrier above.
