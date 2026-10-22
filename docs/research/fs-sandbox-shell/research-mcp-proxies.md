# Research: MCP proxies, gateways and filters, with local (stdio) and remote (HTTP/SSE) upstreams

Date of research: 2026-10-12. All registry and GitHub numbers below came from live calls on that date (commands listed in Method). Confidence labels follow HIGH / MEDIUM / LOW anchors.

## 1. Generalized problem

A policy-enforcing, transparent MCP proxy sits between an MCP host and one upstream MCP server. It intercepts `tools/call` (allow / deny / ask, argument rewriting) and passes everything else through byte-for-byte. It is installed by rewriting the host's MCP config entry, needs no change to host or upstream, and runs as no separately managed service. The upstream may be a local stdio child or a remote Streamable HTTP / SSE server with headers or OAuth.

## 2. Findings that change the design (read first)

1. **MCP has two protocol eras in the wild right now.** Spec revision `2026-07-28` removed the `initialize` handshake, protocol sessions and `Mcp-Session-Id`, SSE resumability (`Last-Event-ID`), `ping`, `logging/setLevel`, and server-initiated requests (sampling / elicitation / roots become the Multi Round-Trip Request pattern: a result with `resultType: "input_required"` that the client answers by retrying the call). It added `server/discover`, `subscriptions/listen`, per-request `_meta` (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`), and HTTP mirror headers `Mcp-Method` / `Mcp-Name`. Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog (read in full, HIGH). Claude Code's "v2 runtime" already speaks it to HTTP **and stdio** servers (probes support, falls back to the old era): https://code.claude.com/docs/en/mcp (section "MCP client runtimes", HIGH). The TypeScript SDK v2 (`@modelcontextprotocol/client` / `server` 2.3.1, Apache-2.0) implements it; SDK v1 (`@modelcontextprotocol/sdk` 1.32.1, MIT) is in maintenance (README of https://github.com/modelcontextprotocol/typescript-sdk).
   Consequence: the specification's compatibility matrix (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning, "Compatibility Matrix", read in full, HIGH) makes mixed pairs the hard case: a Legacy client against a Modern server **fails** (the server rejects `initialize`; legacy clients have no fall-forward), while Dual-era clients work against either. A message-level relay is transparent only when host and upstream speak the same era. For mixed pairs the shim needs a small **era adapter**, scoped to three message kinds: `initialize` / `server/discover` (answer the host's handshake locally and rewrite later requests with per-request `_meta` when the upstream is modern), `notifications/*list_changed` / `subscriptions/listen` (open the listen stream on the legacy host's behalf), and `input_required` results (unpack into 2025-style `sampling/elicitation/roots` requests and retry). mcp-remote `--protocol auto` and mcp-proxy-TS `--upstreamProtocol auto` are the two shipping reference adapters (both READMEs read). Era is a property of the server, so probe once per upstream and cache it (versioning page: clients SHOULD cache per process / origin).
   Recommendation that still holds: relay at message level and keep the adapter narrow, rather than composing SDK `Client` + `Server` (which owns capability negotiation twice and cannot pass server-initiated flows through unchanged).
2. **No existing tool is both (a) a stdio-launchable shim in front of a stdio OR remote upstream AND (b) a per-`tools/call` allow/deny/ask policy point, with a permissive license and healthy maintenance.** The transport bridges (mcp-remote, mcp-proxy, supergateway) have no policy beyond tool-name ignore lists; the policy gateways (agentgateway, ContextForge, ToolHive, Docker gateway, MetaMCP) are listener daemons or platforms. Details in sections 3 and 7.
3. **Rewriting a remote entry to a loopback URL breaks host-native OAuth** (inference from spec, MEDIUM; section 5). A stdio shim that owns upstream auth is the robust way to front a remote URL while the host entry stays stdio, and it is exactly what mcp-remote does.

## 3. Tool catalog

Stars / license / push from `api.github.com/repos/<repo>` on 2026-10-12; npm weekly downloads from `api.npmjs.org/downloads/point/last-week/<pkg>`; versions from `npm view`. `Decision` is for the stated use (transparent policy proxy, config-rewriting, standalone, stdio + remote).

| Tool | Facts (verified 2026-10-12) | Tag | Reason |
|---|---|---|---|
| **mcp-remote** (npm `mcp-remote` 0.14.3, github.com/punkpeye/mcp-remote) | MIT; 1,624 stars; 617,951 wk downloads; pushed 2026-09-21; maintainer on npm is `punkpeye` (the repo originally lived at geelen/mcp-remote, which now 301-redirects) | **agent:approved** (as transport/auth reference and candidate bridge) | Only mature stdio-to-remote shim with full OAuth (DCR, static client info, RFC 8707 `--resource`, per-URL token store `~/.mcp-auth`, `--header`, `--header-file`, `--transport http-first/sse-first/...`, `--ignore-tool` filter on `tools/list` + `tools/call`, `--protocol auto` dual-era). Standalone CLI, not a library; policy is only a glob ignore list. |
| **mcp-proxy (TypeScript)** (npm `mcp-proxy` 6.7.19, github.com/punkpeye/mcp-proxy) | MIT; 292 stars; 787,216 wk downloads; pushed 2026-09-21 | **agent:approved** (as library / design reference) | Library + CLI; stdio child to Streamable HTTP + SSE server, dual-era, `--stateless`, `--apiKey`, CORS. Wrong direction for a shim (it is a listener) and multiplexes all downstream callers onto one upstream connection. |
| **mcp-proxy (Python)** (PyPI `mcp-proxy` 0.13.0, github.com/sparfenyuk/mcp-proxy) | MIT; 2,779 stars; pushed 2026-10-10 | **agent:blocked** | Python runtime; both directions (stdio-to-HTTP and SSE/HTTP-to-stdio with `--headers`, OAuth2 client-credentials `--client-id/--client-secret/--token-url`) but no policy hook and no interactive OAuth. Does not fit an adhd TS/CJS package. |
| **supergateway** (npm `supergateway` 4.1.0, github.com/supercorp-ai/supergateway) | MIT; 2,894 stars; 115,790 wk downloads; pushed 2026-10-09 | **agent:blocked** | Bridges stdio, SSE, WS, Streamable HTTP in all combinations (`--stdio/--sse/--streamableHttp` + `--outputTransport`), `--header`, `--oauth2Bearer` (static token only), passes sampling/roots/elicitation through; no OAuth flow, no policy, listener-oriented. Good matrix reference, wrong shape. |
| **agentgateway** (github.com/agentgateway/agentgateway, v1.6.0 2026-10-02) | Apache-2.0; 5,289 stars; Rust; pushed 2026-10-11 | **agent:blocked** (best policy reference) | Best-in-class declarative MCP authz: `mcpAuthorization.rules` are CEL expressions over `mcp.tool.name` and `jwt.*`; targets `stdio` / `mcp` (host URL) / `sse` / `openapi`; `prefixMode` for tool-name namespacing; `backendAuth.passthrough`. But it is a standalone listener process (host entry would have to be a URL to a running gateway) and a Rust binary. |
| **IBM ContextForge** (github.com/IBM/mcp-context-forge v1.0.11) | Apache-2.0; 4,602 stars; Python; pushed 2026-10-11 | **agent:blocked** | Registry/gateway platform (DB, RBAC, 40+ plugins incl. deny_filter, Cedar, PII). `mcpgateway.translate --stdio ... --expose-sse --expose-streamable-http` is a bridge, but it is a service, not a shim. Policy-plugin model is a good reference. |
| **Docker MCP Gateway** (github.com/docker/mcp-gateway) | MIT; 1,594 stars; Go; pushed 2026-09-23 | **agent:blocked** | `docker mcp gateway run` defaults to **stdio transport** (`--transport stdio|sse|streaming`), so a host entry can be `docker mcp gateway run`. Has `--interceptor before:exec:/bin/path`, `--block-secrets`, `--tools`, `--servers`. But it requires Docker, runs servers as containers from a catalog; no generic "wrap this arbitrary command or URL". Interceptor concept is a good reference. |
| **MetaMCP** (github.com/metatool-ai/metamcp) | MIT; 2,701 stars; last release v2.4.22 on 2025-12-19, last push 2026-06-22 | **agent:blocked** | Docker/Postgres aggregator, namespaces, per-tool name/annotation overrides, middleware, API-key + OAuth; not a standalone shim; release cadence stalled ~10 months. |
| **ToolHive** (github.com/stacklok/toolhive v0.51.4) | Apache-2.0; 2,271 stars; Go; pushed 2026-10-11 | **agent:blocked** | Container-isolated server runner with proxy for remote servers, OIDC, authz, audit; platform-scale, container-centric. Design reference only. |
| **Microsoft mcp-gateway** (github.com/microsoft/mcp-gateway) | MIT; 874 stars; C#; pushed 2026-10-02 | **agent:blocked** | Kubernetes reverse proxy and lifecycle manager; README states it requires `2026-07-28` clients and drops legacy initialization and sessions. Not a local shim. |
| **Lasso mcp-gateway** (github.com/lasso-security/mcp-gateway) | MIT; 395 stars; Python; last push 2026-01-22 | **agent:blocked** | Reads a host `mcp.json` and fronts the listed servers with plugins (basic token masking, presidio, lasso); stdio-only orchestration, 9 months without a push, replaces many entries by one gateway entry (different install model). |
| **Snyk agent-scan (formerly Invariant mcp-scan)** (github.com/snyk/agent-scan; PyPI `snyk-agent-scan`) | Apache-2.0; 3,133 stars; pushed 2026-10-09 | **agent:approved** (as offline companion, not the proxy) | Scanner for tool poisoning, tool shadowing, toxic flows, prompt injection; reads host configs, starts stdio servers or contacts remote URLs (refuses link-local / metadata addresses). Needs a Snyk API token for analysis. Not a runtime interceptor. |
| **Invariant invariant-gateway** (github.com/invariantlabs-ai/invariant-gateway) | Apache-2.0; 82 stars; last push 2025-11-06 | **agent:blocked** | LLM-API proxy (guardrails on model traffic), not an MCP tool-call proxy; stale. |
| **MCP Guardian** (github.com/eqtylab/mcp-guardian) | Apache-2.0; 200 stars; Rust; last push 2025-08-08 | **agent:blocked** | Has a `mcp-guardian-proxy` with per-message approval UI, which is the right idea, but stale >14 months and requires a Nix/Rust/GUI toolchain. |
| **@wasmagent/mcp-firewall** (npm 2.3.1, github.com/WasmAgent/wasmagent-js) | Apache-2.0; 6 stars; 641 wk downloads; pushed 2026-10-09 | **agent:blocked** | Policy library (descriptor integrity, `evaluatePolicy` returning allow / deny / ask_user, consent ledger, taint tracking); README describes functions, not a launchable transport proxy; tiny adoption. Worth reading for the descriptor-pinning idea. |
| **@strixgov/mcp-proxy** (npm 0.2.0) | license `Elastic-2.0` (source-available, not OSI); 2,892 wk downloads | **agent:blocked** | Intercepts every `callTool` against policy, but Elastic-2.0 license and a vendor funnel ("distribution wedge"). |
| **@agimon-ai/mcp-proxy** (npm 0.32.13) | `AGPL-3.0`; 2,688 wk downloads | **agent:blocked** | Copyleft license is incompatible with publishing under the repo's MIT-style npm packages. |
| **@bithyte/mcp-firewall**, **@ziwansi/mcp-firewall**, **@vengtoo/mcp-gateway**, **@deepsweepai/mcp-firewall** | 6 to 13 wk downloads each; versions 0.1.x-0.4.x | **agent:blocked** | Policy-proxy claims but near-zero adoption and no maturity evidence (snippet-level only, READMEs not read: LOW confidence on their feature claims). |
| **PolicyLayer** (hosted) | previously cataloged: memory episodes 01M47W0VDE5EQ4ZKW7ZYKZMQE1 | **agent:blocked** | Hosted SaaS; richest command-level policy language (reference only). |
| **Cloudflare** `mcp-server-cloudflare` and Workers `McpAgent` | Apache-2.0; 4,369 stars | **agent:blocked** | Cloudflare's contribution is hosting remote MCP servers on Workers and its own servers; its `mcp-remote` usage is the punkpeye bridge above. Not a policy proxy. |
| **Envoy AI Gateway** | `github.com/envoyproxy/ai-gateway` now 301-redirects to `theagentrouter/agent-router` (Apache-2.0, 2,214 stars, Go); README describes MCP servers behind Envoy Gateway | **agent:blocked** | Kubernetes / Envoy infrastructure; rename not independently explained (LOW confidence on repo lineage). |

### Not a proxy, but part of the decision

* **Claude Code hooks and permission rules already address MCP tools by name (`mcp__<server>__<tool>`)** (from the existing adhd knowledge of the host; not re-verified in this run, LOW). If name-level allow/deny/ask suffices for a given server, no proxy is needed. A proxy is justified only for argument-level policy, argument rewriting, or hosts without hooks (Cursor, Claude Desktop, VS Code).
* **VS Code** can sandbox local stdio MCP servers on macOS/Linux (https://code.visualstudio.com/docs/copilot/customization/mcp-servers, section "Sandbox MCP servers", HIGH). That confines the process, not the call.

## 4. Comparison: config shape and transport matrix

Downstream = what the host connects to; upstream = the real server. "HTTP" means Streamable HTTP unless noted.

| Tool | Host-config shape | stdio to stdio | stdio to HTTP/SSE (host stdio, upstream remote) | HTTP to stdio (host remote, upstream child) | HTTP to HTTP | Upstream auth | Per-call policy | Tool-name namespacing | Server-initiated (sampling / elicitation / roots) |
|---|---|---|---|---|---|---|---|---|---|
| mcp-remote | `{"command":"npx","args":["-y","mcp-remote","<url>","--header",...]}` | no | **yes** (`--transport http-first/sse-first/http-only/sse-only`) | no | no | OAuth (DCR, static client info, `--resource` RFC 8707 indicator, `--authorize-param`), headers, `--header-file`, `--allow-http` | `--ignore-tool` glob (list + call) | no | bridged incl. 2026 MRTR to 2025-era client (README "Protocol Eras") |
| mcp-proxy (TS) | `{"url":"http://127.0.0.1:PORT/mcp"}` against a running `npx mcp-proxy -- cmd` | no | no | **yes** (`/mcp`, `/sse`) | no | `--apiKey` inbound only | none | no | **does not cross** the proxy (single shared upstream connection; README "What does not cross") except 2026 `input_required` |
| mcp-proxy (Py) | `command` (`mcp-proxy <url> --headers ...`) or URL to running server | no | **yes** (`--headers`, client-credentials OAuth2) | **yes** | no | static headers, client-credentials | none | named servers path `/servers/<name>/` | not documented |
| supergateway | `command` (`supergateway --streamableHttp <url> --oauth2Bearer ...`) or URL to running server | no | **yes** (`--sse` / `--streamableHttp` with `--outputTransport stdio`) | **yes** (`--stdio` with `sse|ws|streamableHttp`) | yes (remote in, remote out) | static bearer / headers | none | no | passed through (README lines on sampling, roots, elicitation) |
| agentgateway | `{"type":"http","url":"http://127.0.0.1:3000/mcp"}` to a running binary | via targets | via `mcp` / `sse` targets | **yes** (`stdio` target) | **yes** | `backendAuth` (passthrough, etc.), JWT/OAuth inbound (`jwtAuth`) | CEL `mcpAuthorization.rules` (tool name, JWT claims) | `prefixMode` (default prefixes by target) | gateway-managed (not verified) |
| ContextForge | URL to `/servers/<id>/mcp` with bearer, or `mcpgateway.wrapper`-style stdio bridging (not verified) | via `translate` | via registered gateway | via `translate --stdio ... --expose-*` | yes | JWT/RBAC, `X-Upstream-Authorization`, per-user OAuth | plugin hooks (deny_filter, Cedar, OPA, PII) | virtual-server composition | not verified |
| Docker MCP Gateway | `{"command":"docker","args":["mcp","gateway","run"]}` | n/a (runs containers) | remote servers via catalog/OAuth (`docker mcp oauth`) | `--transport sse|streaming` + `--port` | n/a | Docker Desktop secrets, built-in OAuth flows | `--interceptor before:exec:<bin>`, `--tools`, `--block-secrets` | per-server | not documented |
| MetaMCP | URL (SSE / Streamable HTTP) or stdio shim | via Docker app | yes | yes (stdio servers hosted) | yes | API key, OAuth (2025-06-18) | middleware at namespace level | namespaces; per-tool rename | not documented |
| Lasso gateway | `command` `mcp-gateway --mcp-json-path ... -p basic` | **yes** | no | no | no | env only | plugins (masking, presidio) | `<server>_<tool>` style (not verified) | not documented |

Hosts' own config shapes (HIGH unless noted):

| Host | Local entry | Remote entry | Notes |
|---|---|---|---|
| Claude Code (`.mcp.json`) | `{"command","args","env"}`; `type` omitted or `"stdio"` | `{"type":"http"|"sse"|"ws","url","headers","headersHelper","oauth":{"clientId","callbackPort","authServerMetadataUrl","scopes"}}`; `streamable-http` accepted as alias of `http`; a `url` without `type` is read as stdio and skipped | `${VAR}` and `${VAR:-default}` expansion; per-server `timeout`; OAuth driven from `/mcp` in the host; SSE transport documented as deprecated. Source: https://code.claude.com/docs/en/mcp |
| Cursor (`mcp.json`, key `mcpServers`) | `command` / `args` / `env` | `url` + `headers`; optional `auth` object `{CLIENT_ID, CLIENT_SECRET, scopes}` for static OAuth; transports stdio, SSE, Streamable HTTP (OAuth supported) | Source: https://cursor.com/docs/context/mcp |
| VS Code (`mcp.json`, key `servers`) | `command` / `args` | `{"type":"http","url":...}` | Optional per-server sandbox for local stdio. Source: https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
| Claude Desktop (`claude_desktop_config.json`, key `mcpServers`) | `command` / `args` | none in the JSON file (remote servers are added through the app's connectors UI; MEDIUM, from https://modelcontextprotocol.io/docs/develop/connect-local-servers which shows only stdio entries) | Stdio shim is the only way to front a remote URL from the JSON file. |

## 5. Wrapping strategies for remote upstreams in a config-rewriting wrapper

**Strategy A: stdio shim (host entry becomes `command`).** `{"command":"<wrapper>","args":["--upstream-url","https://x/mcp", ...]}`, with the original entry stored by the installer so it can be restored.

* Works in every host, including Claude Desktop. Host-config validity trivial (stdio).
* Lifecycle is the host's: the host spawns and reaps the process, so "no extra running service" is satisfied literally.
* The shim owns upstream credentials: static headers (env or file), or the OAuth dance as mcp-remote does it (loopback callback server, token store keyed by URL + resource + headers, refresh). The MCP authorization spec says stdio implementations SHOULD NOT follow the OAuth section and should read credentials from the environment (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, line "Implementations using an STDIO transport SHOULD NOT follow this specification"), so OAuth-in-a-shim is an established convention (mcp-remote) rather than spec-mandated, and must be designed deliberately.
* Loses: the host's native OAuth UI (`/mcp` in Claude Code, Cursor's OAuth button) and host-managed token storage for that server; per-host-session processes mean token-file locking is required.
* Era handling: the downstream is stdio, so Claude Code v2 probes `server/discover` over stdio and falls back to `initialize`. Same-era pairs relay unchanged; mixed pairs need the narrow era adapter described in section 2 (mcp-remote `--protocol auto` shows what that costs: it answers the local handshake itself, opens `subscriptions/listen` for a legacy host, and unpacks `input_required`).

**Strategy B: rewrite `url` to a loopback proxy URL (host entry stays `type: http`).**

* Needs a process already listening on 127.0.0.1 before the host connects; the host will not spawn it. That is an extra running service (violates the stated constraint) unless something lazy-starts it.
* OAuth breaks or doubles: the host runs the spec flow against the loopback URL, uses it as the RFC 8707 `resource` (the spec says clients MUST send the canonical URI of the MCP server they intend to access; https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization, "Canonical Server URI"), and discovers authorization servers from protected-resource metadata served by the loopback proxy. For the real upstream's authorization server to issue a usable token, the proxy would have to impersonate the resource (its own PRM and likely its own authorization server), which is precisely the MCP "proxy server" shape the security guide flags for confused-deputy risk (per-client consent, redirect-URI validation, `state` handling all MUST). Conclusion MEDIUM confidence (inference from spec text, not tested against a live host).
* Static-header upstreams are easy in B (proxy injects headers), but then every host sends a loopback `Authorization` to a local port, so the proxy needs its own inbound auth plus Origin validation and loopback-only binding (spec MUST for Origin on Streamable HTTP; Docker's gateway uses `MCP_GATEWAY_AUTH_TOKEN` for this).
* Pros: preserves host-native HTTP behavior (streaming UI, host-side reconnect) and one process can serve many sessions.

**Recommendation: A as the default and only automatic rewrite**; treat B as an explicit opt-in for hosts/users who already run a policy daemon (agentgateway-style). Concretely:

1. Installer rewrites `{type:"http"|"sse", url, headers, oauth}` into `{command, args:["--upstream", "<ref>"]}` where `<ref>` is a path to a sidecar file holding the original entry (so secrets and `${VAR}` references are never copied into the committed `.mcp.json` as expanded values). The wrapper expands `${VAR}` itself using the host's rules (Claude Code expands in `command`/`args`/`env`/`url`/`headers`).
2. Honor the host's OAuth hints already present in the original entry (`oauth.clientId`, `callbackPort`, `authServerMetadataUrl`, `scopes`; Cursor `auth.CLIENT_ID`) as static client info, and `headersHelper` as a header source. First run needs an interactive-capable browser launch; document the non-interactive failure mode.
3. Relay at message level. Reuse `@modelcontextprotocol/client` 2.x as the **upstream transport layer only** (`StreamableHTTPClientTransport`, `StdioClientTransport` from the `/stdio` subpath, `OAuthClientProvider`/auth helpers, injectable `fetch`) and pump its `Transport` messages to a stdio server transport. Do not use `Client.callTool` / `Server.setRequestHandler` composition: that forces you to own capability negotiation and breaks era passthrough.
4. Pass `tools/list` through unchanged unless policy hides tools; if it hides tools, the same filter must also deny the corresponding `tools/call` (mcp-remote's `--ignore-tool` does both).
5. Keep a per-process id map so cancellation (`notifications/cancelled`), progress tokens and `input_required` retries correlate; never merge multiple downstream callers onto one upstream (mcp-proxy-TS documents this as the reason elicitation cannot cross).
6. Resolve upstream URL for SSRF at connect time through an injected `fetch`/undici dispatcher (adhd already approved this pattern: memory episode 01M4Q197G3X1B5JCK462HPBXV2, undici `connect.lookup`), and re-check on every redirect.

## 6. Spec requirements a transparent proxy must honor

* **Version negotiation / eras.** 2025-era: client `initialize` proposes a version, server answers; Streamable HTTP clients send `MCP-Protocol-Version` on later requests. 2026-07-28: no handshake; each request carries version and capabilities in `_meta`; mismatch is `UnsupportedProtocolVersionError` (-32022); `server/discover` replaces `initialize` as the probe (servers MUST implement it). A passthrough relay must not rewrite `_meta` or `resultType`. Source: 2026-07-28 changelog (HIGH).
* **Capability passthrough.** Do not inject or strip capabilities. An `ask` decision needs a channel to a human: on the 2025 era that is `elicitation/create` toward the client, usable only if the client declared the elicitation capability; on 2026-07-28 servers cannot initiate requests, so the proxy must answer the pending `tools/call` with an `input_required` result and, on the client's retry, strip `inputResponses` / `requestState` before forwarding the call upstream (MEDIUM from changelog items 7 and 8; **whether Claude Code and other hosts render a proxy-originated `input_required` for a tool whose upstream never asked is unverified: LOW**). Sampling, Roots and Logging are Deprecated in 2026-07-28, so do not build new features on them. When no channel exists the call must be denied (matches AK-03 in architect-spec-gateway.md).
* **Sessions.** 2025-era: `MCP-Session-Id` assigned at initialize MUST be echoed on all later requests; 2026-07-28 removes it (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports, https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). A shim fronting HTTP must hold the upstream session id internally and never expose it downstream (stdio has none).
* **Resumability.** 2025-era optional `Last-Event-ID` GET resume; removed in 2026-07-28 (a broken stream loses the request; the client re-issues with a new id). A shim should surface upstream stream loss as a JSON-RPC error for the in-flight request rather than silently replaying `tools/call`, which is not idempotent.
* **Cancellation.** stdio: `notifications/cancelled`; Streamable HTTP 2026: close the request's response stream. A shim bridging them must translate (stdio downstream cancel becomes closing the upstream POST stream).
* **Headers (2026-07-28).** `Mcp-Method` and `Mcp-Name` MUST mirror the body; the server returns `HeaderMismatch` (-32020) on mismatch. If a proxy rewrites `tools/call` arguments or tool name (namespace prefix removal), it must regenerate `Mcp-Name` and any `Mcp-Param-*` headers (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http, request-metadata section; HIGH).
* **Authorization.** Tokens MUST be issued for the MCP server as audience (RFC 8707 `resource`, canonical URI); servers MUST NOT accept other tokens; token passthrough to downstream APIs forbidden; access tokens never in query strings; clients validate RFC 9207 `iss` and key credentials by issuer (2026-07-28 changelog minor items 7 and 9). Sources: authorization and security best practices pages (HIGH).
* **Streamable HTTP server duties (if the proxy ever listens):** validate `Origin`, bind 127.0.0.1, authenticate (transports page; HIGH).
* **TS SDK facts (npm pack of `@modelcontextprotocol/client@2.3.1`, Apache-2.0, Node >=20, dual CJS + ESM, deps cross-spawn, eventsource, jose, pkce-challenge, zod ^4):** exports `StreamableHTTPClientTransport`, `SSEClientTransport` (legacy), `OAuthClientProvider`, `ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `UnauthorizedError`, `createMiddleware`/`withOAuth` fetch wrappers, `requestInit`/`fetch` injection, `StdioClientTransport` at `@modelcontextprotocol/client/stdio`. **No proxy helper exists** (no match for proxy/relay/passthrough in the repo tree). Shipping CJS satisfies ADR-0003 (adhd packages publish CommonJS only; docs/decisions/0003-adhd-packages-publish-commonjs-only.md, title only, not re-read in full).

## 7. Antipatterns and security issues

| Antipattern | Why | Mitigation |
|---|---|---|
| **Token passthrough** (accepting a client token and forwarding it unvalidated to an API) | Explicitly forbidden: bypasses audience-bound controls, breaks audit, enables exfiltration via the proxy (security best practices, "Token Passthrough") | A transparent shim forwards only credentials it was configured with for that upstream, or tokens it obtained itself for that exact `resource`. Never forward the host's own tokens to a different upstream. |
| **Confused deputy in OAuth-proxy shape** (static client ID + DCR + consent cookie) | Attacker skips consent via cookie (security best practices) | Do not become an authorization-server-facing proxy (Strategy B); if unavoidable, per-client consent storage, exact redirect URI match, `state` cookie set only after consent. |
| **SSRF through configurable upstream URL** | Config or a poisoned shared `.mcp.json` can point the shim at 169.254.169.254, RFC1918, or loopback services; OAuth discovery URLs from the server add more fetches (security best practices, "SSRF") | HTTPS only (except explicit allow-http for loopback), resolve-then-connect IP check via custom dialer, re-validate on redirects, block link-local and metadata ranges (agent-scan does this for link-local/metadata; Claude Code refuses OAuth over plain http except localhost). |
| **stdio-spawning proxy reachable over HTTP** | An authenticated local HTTP endpoint that spawns commands is an RCE escalation path (security best practices, "stdio Transport Security in Proxy Scenarios") | Shim reads its command from a local file, accepts no commands from the network, listens on nothing. Another argument for Strategy A. |
| **Session fixation / hijack** | Guessable or reusable `MCP-Session-Id`; session-hijack prompt injection via shared queues | Hold upstream session ids in-process only; never log them; 2026 era removes the problem. |
| **Tool poisoning / rug pull via `tools/list` changes** | Descriptions are model-visible instructions; servers can change them after approval (papers below) | Pin a hash of each tool's name + description + inputSchema at first approval; on `notifications/tools/list_changed` or any changed `tools/list`, re-prompt or deny. A passthrough proxy is the right place for this check because it sees every list. |
| **Name-based policy only** | A `Bash`-like tool hides arbitrary behavior behind one name (PolicyLayer note in memory) | Policy over arguments (path / command patterns), fail closed on parse failure; keep argument rewriting deterministic and logged. |
| **Fail-open on policy error / on `ask` without a channel** | If the host cannot render a prompt (2026 era has no server-initiated elicitation) an `ask` silently becomes allow or hangs | Define `ask` fallback explicitly (deny by default), and use `input_required` or the 2025 `elicitation/create` only when the client declared the capability. |
| **Multiplexing callers onto one upstream connection** | Server-initiated requests carry no caller identity (mcp-proxy-TS README) | One upstream connection per downstream connection. |
| **Secrets in process args** | `ps` exposure (mcp-remote added `--header-file` for this reason) | Use env or sidecar file references in the rewritten entry. |

Scholarly sources (abstracts read via arxiv.org/abs on 2026-10-12): MCP Safety Audit https://arxiv.org/abs/2504.03767; MCPTox tool-poisoning benchmark https://arxiv.org/abs/2508.14925; STRIDE threat model of MCP clients https://arxiv.org/abs/2603.22489; realistic poisoning benchmark https://arxiv.org/abs/2605.24069; ShareLock multi-tool threshold poisoning https://arxiv.org/abs/2606.27027; remote-MCP ecosystem measurement https://arxiv.org/abs/2609.19100 (abstract only; claim that the ecosystem is moving from local processes to remote Streamable HTTP supports prioritizing remote-upstream support). Papers were not read beyond abstracts (LOW-MEDIUM for any claim beyond "tool poisoning is demonstrated against real servers").

## 8. Build vs integrate verdict

**Policy layer: build.** No candidate combines stdio-launchable shim, tool-call argument policy, healthy maintenance, and a permissive license. The best policy references (agentgateway CEL rules, ContextForge plugin hooks, Docker `--interceptor`, PolicyLayer allow/deny/ask) are daemons or platforms.

**Transport-bridging layer: integrate the SDK, do not fork a tool.**

| Option | License | Verdict |
|---|---|---|
| `@modelcontextprotocol/client` 2.3.1 as library (StreamableHTTP + stdio transports + OAuth provider interface) | Apache-2.0 | **Use.** Official, dual-era aware, CJS-compatible, injectable fetch for SSRF guard. You still write the relay, OAuth provider (token store, loopback callback), and policy engine. |
| mcp-remote as a **dependency** | MIT | It is an application, not a library (CLI entry; verified README only, package exports not inspected; LOW on programmatic reuse). Reuse its design (token store layout, `--resource`, `--transport` fallback order, header-file, dual-era shim) and consider running it as a child process only as an emergency fallback. Maintainer change (geelen to punkpeye) is a continuity risk to note. |
| mcp-proxy (TS) as library | MIT | Wrong direction (listener, multiplexed). Useful for testing the shim against an HTTP-fronted stdio fixture. |
| supergateway / mcp-proxy (Py) | MIT | Matrix reference and test fixtures only. |
| agentgateway | Apache-2.0 | Offer as the documented "bring your own daemon" Strategy B target; do not embed (Rust binary, separate service). |
| @agimon-ai/mcp-proxy | AGPL-3.0 | Do not use or copy. |
| @strixgov/mcp-proxy | Elastic-2.0 | Do not use. |

Net: write a small relay package (message pump, `tools/call` interceptor, policy evaluation with allow / deny / ask / rewrite, descriptor pinning, upstream config sidecar) on top of the official client SDK transports; copy mcp-remote's OAuth operational lessons rather than its code. Keep the relay protocol-agnostic so the 2025 and 2026-07-28 eras both work.

## 8b. Conflicts and alignments with existing adhd design documents

Read in full or in relevant part: `docs/research/fs-sandbox-shell/architect-spec-gateway.md` (the draft `wrap` entrypoint spec), `docs/decisions/0008-agent-mcp-native-tooling.md` (D5/D7), `docs/decisions/0003-adhd-packages-publish-commonjs-only.md` (header and decision statement). `architect-interfaces-gateway.md` was only skimmed (header, IPolicyClient port).

* **WM-02 (status U) conflicts with WM-01 and WM-08 as soon as the original is remote.** WM-02 says `wrap` "MUST speak the same MCP transport to the host that the original server did (stdio, and http where the original used it)". Presenting http to the host is Strategy B, which needs a listening process (violates WM-08 "MUST NOT require a running ... server") and cannot be expressed in the WM-01 entry form `command: <wrap bin>, args: [--server <name>, --, <original command>...]` (that form has no place for a URL). This research recommends resolving WM-02 as: **host-facing side is always stdio; the upstream side is stdio or http per the original entry.** WM-01 then needs a second form, `args: [--server <name>, --upstream <sidecar-ref>]`, for remote originals.
* **WM-03 ("pass `initialize` ... through unchanged") is era-specific.** Under 2026-07-28 there is no `initialize`; with mixed eras `wrap` needs the adapter in section 2. Reword WM-03 to "pass the handshake / discovery exchange through, adapting eras only when host and upstream differ".
* **GW-10 (sampling handled or blocked explicitly)** should add that 2026-07-28 replaces server-initiated sampling / elicitation / roots with `input_required` results, and that these three features are Deprecated.
* **AK-01 / AK-03 (ask goes to the host; no channel means deny)** match the recommendation, with the added caveat that a proxy-originated approval prompt on the 2026 era depends on an unverified host behavior (LOW).
* **GW-03 (tool names pass through unchanged)** is consistent with the transparency requirement; it rules out agentgateway-style default target prefixing. If argument rewriting renames anything, `Mcp-Name` must be regenerated on HTTP (section 6).
* **GW-12 / GW-14 and ADR-0008 D5 / D7** agree with this research: argument-level policy is best-effort, not a security boundary; the OS sandbox is. ADR-0008 forbids agent-mcp itself from owning command-pattern catalogs; the `wrap` entrypoint lives in `@adhd/policy`, so no ADR-0008 violation is evident, but that is the owner's call (not verified against the policy package's ADR status).
* **ADR-0003 (CJS-only publish)** is satisfied by `@modelcontextprotocol/client` 2.3.1 (dual CJS/ESM build verified in the tarball) and by mcp-remote only as an external CLI. It is a reason not to depend on ESM-only helper libraries.
* No document read assumes SDK `Client` + `Server` composition.

## 9. Open items and caveats

* Not verified live: Cursor's behavior when a stdio shim triggers its OAuth UI (it will not); whether Cursor/VS Code expand `${VAR}` in args; ContextForge `wrapper` module existence; Lasso and MetaMCP tool-name prefixing details; agentgateway stdio-target behavior with server-initiated requests.
* mcp-remote programmatic API and whether `--ignore-tool` also guards `resources/read` are unverified.
* The Strategy B OAuth incompatibility is derived from spec text, not tested against a live host.
* Memory prior work: no prior episode catalogs MCP proxies/gateways beyond PolicyLayer (01M47W0VDE5EQ4ZKW7ZYKZMQE1), the undici SSRF guard (01M4Q197G3X1B5JCK462HPBXV2) and SSRF helpers (01M4Q19DN7V9FTA1EY318YVA7M).

## Method (commands run, 2026-10-12)

`scratch-agent-search` (npm, duckduckgo, arxiv, fetch providers); `api.github.com/repos/<repo>` for stars/license/push; `api.github.com/repos/<repo>/releases/latest`; `npm view <pkg> version license repository.url time.modified`; `api.npmjs.org/downloads/point/last-week/<pkg>`; raw READMEs from raw.githubusercontent.com; spec pages from modelcontextprotocol.io and the spec repo; `npm pack @modelcontextprotocol/client@2.3.1` (inspected package.json and `dist/index.d.cts` export names). Several `scratch-agent-search` calls run in parallel returned empty output; those were re-run sequentially or replaced by direct curl.

## URL index

* https://modelcontextprotocol.io/specification/2026-07-28/changelog
* https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
* https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
* https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
* https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
* https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
* https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
* https://code.claude.com/docs/en/mcp
* https://cursor.com/docs/context/mcp
* https://code.visualstudio.com/docs/copilot/customization/mcp-servers
* https://modelcontextprotocol.io/docs/develop/connect-local-servers
* https://github.com/modelcontextprotocol/typescript-sdk
* https://github.com/punkpeye/mcp-remote
* https://github.com/punkpeye/mcp-proxy
* https://github.com/sparfenyuk/mcp-proxy
* https://github.com/supercorp-ai/supergateway
* https://github.com/agentgateway/agentgateway
* https://github.com/IBM/mcp-context-forge
* https://github.com/docker/mcp-gateway
* https://github.com/metatool-ai/metamcp
* https://github.com/stacklok/toolhive
* https://github.com/microsoft/mcp-gateway
* https://github.com/lasso-security/mcp-gateway
* https://github.com/snyk/agent-scan
* https://github.com/invariantlabs-ai/invariant-gateway
* https://github.com/eqtylab/mcp-guardian
* https://www.npmjs.com/package/@wasmagent/mcp-firewall
