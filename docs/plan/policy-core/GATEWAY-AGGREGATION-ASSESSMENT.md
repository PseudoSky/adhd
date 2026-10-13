# Assessment: MCP aggregation gateway ("fan-in serve") for adhd-policy

Date: 2026-10-13. Author: product. Status: assessment, owner decision pending. Scope: WHAT and WHY only; technical soundness of any build goes to `architect-decision` before work starts.

Citation key: repo paths are relative to `.worktrees/policy-core`. `RES` = the researcher survey run for this assessment (primary-source URLs below; 15 findings written to memory, topic `tool-catalog`). `MEM` = project memory. `LOCAL-RES` = `docs/research/fs-sandbox-shell/research-mcp-proxies.md` (untracked, lives only in the main checkout `/Users/nix/dev/node/adhd`, read there). `docs/plan/policy-core/MEASUREMENTS.md` did not exist when this was finished; the single-wrapper overhead numbers are therefore not used and are a named gate below.

## 1. The proposal

Today `adhd-policy mcp-json init` rewrites each stdio entry into `adhd-policy serve bin:<cmd> --spec <f> -- <args>` (`entrypoint/policy/src/wrapper/mcp-json/init.ts:44`, doc `:104-120`). Each wrapped entry is one Node policy process fronting one upstream child (`entrypoint/policy/src/wrapper/verbs/serve.ts:41-53`). The owner wants an additional path: one `adhd-policy` endpoint that fronts a full set of servers, applies policy over all of them, and routes each call to the owning upstream. Claimed wins: one MCP in the agent's view (less tool-schema context) and fewer processes and RAM.

## 2. User problem and personas

| Persona | Problem | Does fan-in solve it? |
|---|---|---|
| P1 Solo power user running Claude Code / Cursor with 5-15 MCP servers | Tool schemas crowd the context window; many idle servers | Context: only if the gateway also reduces what it advertises (section 4). Processes: partly. |
| P2 Security-minded operator who wants one policy, one audit log, one place to change rules | Policy spread over N wrapper entries, N spec arguments to keep in sync | Yes, this is the strongest fit. `init` already points every entry at one spec file, so drift is a smaller problem than it looks, but one process means one audit stream and one place to enforce. |
| P3 Team on a host with no tool deferral and no PreToolUse hook (some IDE hosts, headless runners) | Cannot gate or trim tools natively | Yes. A gateway is the only enforcement point they have. |
| P4 Claude Code user | Same as P1, but the host already defers MCP tool definitions and has argument-level hooks (RES, section 3 and "Claude Code native alternative") | Weak. Two of the three claimed benefits are already covered natively. |

## 3. Evidence the problems are real

Context bloat is real and measured locally. A `performance` agent call through agent-mcp sent 67,277 prompt tokens, of which MCP tool schemas were 58,158 (86%); one backlog tool (`batch_action`) was about 19.7k tokens alone (MEM 01M4CH9WQW5M7MSGMSMW88RWN6, report `tmp/agent-mcp-live/perf-triage/report.md`). Anthropic publishes comparable numbers: 5 servers / 58 tools about 55K tokens, about 8.7K with tool search, and MCP tool-selection accuracy 49% to 74% on Opus 4 (https://www.anthropic.com/engineering/advanced-tool-use). Its docs say selection degrades past 30-50 tools (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool). Academic support (RAG-MCP, arXiv 2505.03275) is small, non-Claude and qualitative only.

Process cost is plausible but unmeasured. No published per-process RSS exists for stdio MCP servers or relays (RES section 4). The only datapoint (`desty2k/mcp-benchmark`, framework servers over HTTP, Node idle 162 MB) is not a stdio wrapper. A wrapper's real overhead is the open measurement (MEASUREMENTS.md).

## 4. Where the proposal is weak (read this first)

1. **Merging servers does not cut context.** The union of tools is the same set of schemas. A gateway that lists every upstream tool advertises exactly what the N entries advertised. The local 58k-token finding was fixed by dropping and compacting servers and tools, not by merging them (MEM above). The lever is *what the gateway advertises*, not *how many endpoints* there are.
2. **Today's policy does not trim the list either.** A denied tool stays listed and is refused at call time (`docs/plan/policy-core/INTERFACES.md:23`, D-08; `packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-passthrough-server.ts:77-79`). `tools/list` is a constant captured at startup (`mcp-passthrough-server.ts:121`) and the server declares `tools: {}` with no `listChanged` (`:123`); `apigen-plugin-mcp` has zero `listChanged` references (rg over `packages/apigen/apigen-plugin-mcp/src`, 0 hits). Policy-filtered `tools/list` would deliver the context win to BOTH paths and is cheaper than a gateway.
3. **The hosts that matter most already defer.** Claude Code defers MCP tool definitions by default and loads only names at start; it turns this off behind a non-first-party `ANTHROPIC_BASE_URL` (https://code.claude.com/docs/en/mcp). OpenAI has `defer_loading` tool search (https://developers.openai.com/api/docs/guides/tools-tool-search). Claude Code PreToolUse hooks already give argument-level allow/deny/ask over every MCP tool (https://code.claude.com/docs/en/hooks). A gateway can also hurt: behind one entry, `mcp__<server>__` globs, `alwaysLoad` and per-server instructions collapse onto one server name unless the gateway embeds the upstream name in each tool name (RES, inference from docs, untested).
4. **Process savings are only the wrapper half.** A gateway still spawns every upstream (`mcp-source.ts:75-80`). Saved: N Node wrapper processes, replaced by one. Processes go from 2N to N+1. RAM saved equals N-1 wrapper baselines, number unknown until MEASUREMENTS.md lands. If that baseline is small, the RAM claim dies.
5. **"Use apigen's polyglot gateway" overstates the reuse.** `createGateway` routes by `operation.host`, a *language runtime* tag, with adapters keyed by host and a throw on duplicates (`packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:398-399`, `:417-422`; SPEC `docs/apigen/SPEC.md:521-545`). Every MCP-source operation is stamped `host: 'ts'` (`sources/mcp-source.ts:192`). The `HostAdapter` seam is shaped for apigen requests (`data`, `envelope`, `:171-189`), not MCP passthrough, and `serve` does not use `createGateway` at all (`serve.ts:41-53`). What is reusable is the failure model as a *specification* (partial availability, readiness gating, restart with backoff, deadlines, `gateway.ts:10-21`), not the code.
6. **The passthrough server is single-source by construction.** `serveMcpPassthrough` takes one `source` (`mcp-passthrough-server.ts:33`) and shuts the whole server down when that upstream closes (`:187-189`). In a fan-in, one dead upstream would disconnect the host from all of them. Failure isolation must be built, not inherited.
7. **"Layering auth" bundles a layer that is not built.** The plan lists the auth layer as not built (`docs/plan/policy-core/README.md`, "Not built" list). For stdio the MCP spec says implementations read credentials from the environment, so identity exists only at launch (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization; `docs/plan/policy-core/spec/research-auth-mechanisms.md`, headline 3). Delegated identity is an HTTP-era feature; the proposal's auth value arrives only with a remote transport, which is also unbuilt (backlog f6bf8550 per README).
8. **Moving spec.** Spec 2026-07-28 removes `initialize`/sessions and requires `tools/list` not to vary per connection or as a side effect of other requests (RES, https://modelcontextprotocol.io/specification/2026-07-28/server/tools; LOCAL-RES finding 1 at line 11). The passthrough is built on the SDK v1 `Server` with the initialize handshake (`mcp-passthrough-server.ts:123`). Dynamic tool surfaces (Docker-style `mcp-add`) are in tension with that spec text (RES, inference). Any `listChanged` design needs an architect read.
9. **The previous research chose the opposite default.** LOCAL-RES line 14 found no shim-shaped tool; line 98 says never multiplex callers onto one upstream connection; line 156 (GW-03) pins tool names unchanged, which an aggregator cannot keep (the MCP spec says aggregators SHOULD prefix, https://modelcontextprotocol.io/specification/2026-07-28/server/tools). Neither rules fan-in out, but fan-in re-opens GW-03 and must say so.
10. **An existing bug blocks both paths.** Wrapped entries lose their `env`: the allowlist passes only `PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL` plus `spec.env` (`sources/process.ts:48-56`), `serve` never passes `env` to `resolveSource` (`serve.ts:41-46`), and `init` leaves `env` on the outer entry (`init.ts:104-120`). Backlog c6ca91d6 (open) records it. A fan-in has the same problem multiplied by N: per-upstream env must be modelled, not inherited.

## 5. Prior art (what the market already does)

Primary-source survey, 2026-10-13, details and URLs in RES.

| Product | Relevant design | Lesson for us |
|---|---|---|
| Docker MCP Gateway (MIT, 1.6k stars, https://github.com/docker/mcp-gateway) | One gateway, one container per server; servers start on demand; `--tools server:tool` filter; dynamic `mcp-find`/`mcp-add`/`code-mode` meta-tools; `--interceptor` hook | Lazy start and tool filter are table stakes. Needs Docker; not a wrap-any-command shim. |
| agentgateway (Apache-2.0, 5.3k stars) | `prefixMode` conditional/always/never; CEL `mcpAuthorization`; a target that fails to start fails initialize for the whole backend | Best policy reference. Documents the exact failure-isolation weakness we must avoid. |
| MetaMCP (MIT, 2.7k, last release 2025-12-19) | Namespaces, per-tool rename, middleware filtering; Docker + Postgres; idle sessions pre-allocated | Platform, not a shim; release cadence stalled. |
| MCPJungle (MPL-2.0, 1.3k) | `server__tool` names; tool groups include/exclude; stdio process per call by default | Naming convention to copy; per-call spawn trades RAM for latency. |
| Lasso mcp-gateway (MIT) | Only two meta-tools, `get_metadata` and `run_tool` | The meta-tool extreme; gives up native schemas and validation. LOCAL-RES wrongly lists it as `<server>_<tool>` prefixing. |
| IBM ContextForge, Microsoft mcp-gateway | Registry/Kubernetes platforms with RBAC | Not local shims. |
| TBXark/mcp-proxy, sparfenyuk/mcp-proxy | Per-server routes, not merged | Not true aggregators. |
| Native host deferral (Anthropic, OpenAI) | Definitions loaded on search | Competes directly with the context claim. |

Positioning gap that remains: no surveyed product is a stdio-launchable, wrap-any-command, argument-level allow/deny/ask gateway with a permissive license (LOCAL-RES line 14, still consistent with RES). That gap exists with or without fan-in; fan-in is one way to occupy it.

## 6. How it composes with policy (what must be decided)

| Topic | Current fact | Fan-in requirement |
|---|---|---|
| Namespacing | Operation id is `<source>.<tool>`, source is the user alias or command basename, never the upstream's `serverInfo.name` (`mcp-source.ts:36-39`, `:187`; D-08) | Wire name must carry the source so host globs stay per-upstream, e.g. `<source>__<tool>`. Collisions inside a source are skipped and reported (`mcp-source.ts:183-186`); across sources the prefix resolves them. Alias collision between two entries is an init-time error. |
| Policy ids | Policies already target `<source>.<tool>` ids | Unchanged; one spec can name several sources. |
| Lazy start | `serve` starts the upstream eagerly at resolve, handshake default 10 s (`mcp-source.ts:12`, `:124`) | Eager start of N upstreams makes startup the sum or max of N handshakes and fails closed if any fails (D-08). Lazy start needs a cached tool list or `tools/list` blocks on the slowest upstream. Open: IF-S2 (`spec/architect-interfaces-sources.md:99`). |
| Failure isolation | Upstream exit shuts the whole server (`mcp-passthrough-server.ts:189`) | One upstream down must fail only its tools (`unavailable`), keep the rest serving, restart with backoff: the gateway failure model, `docs/apigen/SPEC.md:538`. |
| Env and credentials | Allowlisted env only (`process.ts:48-56`); bug c6ca91d6 | Per-upstream env from its original entry, no cross-upstream leakage. One process then sees every upstream's config, but children get only their own env. |
| `tools/list` | Full, constant, denied tools listed | Policy-filtered list (hide `deny`) is the context lever; needs `listChanged` or a restart for policy edits. Open IF-S3 (`spec/architect-interfaces-sources.md:100`). |
| Tool-count scaling | N/A today | Past roughly 30-50 advertised tools selection degrades (Anthropic doc above). Meta/search tool is the escape hatch (section 8, non-goal for MVP). |
| Timeouts | Per-call 120 s default (`mcp-source.ts:14`) | Per-upstream timeout; one slow upstream must not starve others. |

## 7. Risks

| Risk | Severity | Note |
|---|---|---|
| Single point of failure | High | One crash drops every tool; per-entry wrapping fails per server. Mitigate with per-upstream supervision plus an easy fallback to per-entry (`mcp-json init --undo` already exists: `mcp-json/undo.ts`). |
| Blast radius of one process | Medium | Children receive only their own env, but a compromised gateway process can reach all upstream stdio streams and the config. Per-entry wrapping bounds this per process. Concentration argument is inference (RES, no primary source). |
| Head-of-line blocking | Medium | One event loop for all upstream traffic; a large result from one server delays others. Not measured. |
| Delegated identity / confused deputy | Medium (HTTP only) | No inbound auth on stdio; token passthrough is forbidden by spec ("MUST NOT accept or transit any other tokens", authorization spec above). Defer until a remote transport exists. |
| Tool poisoning across servers | Medium | An aggregated list lets one server's descriptions influence calls to another (Invariant disclosure, https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks). Policy cannot see descriptions; pin description hashes is a mitigation, not MVP. |
| Annotation trust | Low | Already handled: `safe` is always false, hints advisory (`mcp-source.ts:196-199`). |
| Debugging | Medium | One process, N upstream stderr streams; logs must be tagged by source. |
| Spec drift (2026-07-28) | Medium | See weakness 8. |

## 8. Non-goals

- Replacing per-entry wrapping; `init` stays the default and the fallback.
- Remote (HTTP/SSE) upstreams and OAuth/delegated identity (separate, unbuilt: backlog f6bf8550, auth layer).
- A meta/search tool (`search_tools` + `call_tool`). It cuts context hardest but loses native schema validation and policy argument matching on an opaque payload, duplicates native deferral on the main hosts, and Lasso/Docker already occupy it. Revisit only if tool count remains a problem after policy-filtered `tools/list`.
- Dynamic upstream add/remove at runtime (`mcp-add` style).
- Hot reload of upstream sets, containers, or sandboxing (sandbox is a separate package with its own approval).
- A new package. Any work lands in existing `apigen-engine-gateway` and `entrypoint/policy` (repo rule: no new packages without approval).

## 9. Success metrics

Measured against the same N servers, on the same host, per-entry wrapping versus fan-in. Thresholds marked "proposed" are mine and need owner agreement once MEASUREMENTS.md exists.

| Metric | How | Target |
|---|---|---|
| Process count | `ps` tree under the host after startup | Deterministic: 2N down to N+1. Reported, not gated. |
| Total RSS | Sum of RSS across the wrapper and upstream tree | Proposed gate: saved memory must exceed the single-wrapper baseline times (N-1) minus the fan-in's own growth; if the saving is under 50 MB at N=8, drop the RAM claim. |
| Tool-schema tokens in context | Provider-reported prompt tokens, as in the 67,277 / 58,158 measurement | Fan-in with unfiltered list: no change expected (this is the hypothesis to confirm). With policy-filtered list: reduction equal to denied-tool tokens. |
| Added latency | p50/p95 `tools/call` versus direct and versus single wrapper | Proposed: fan-in adds under 25 ms p95 over a single wrapper. |
| Time to first `tools/list` | Cold start of the host session | Proposed: no worse than the slowest single wrapper plus 2 s. |
| Failure isolation | Kill one upstream | Others keep answering; killed upstream's tools return a clear error; recovers after restart. Binary. |
| Adoption (post-ship) | Count of mcp.json files initialised in fan-in mode versus per-entry (opt-in telemetry exists via `telemetry.ts`) | Informational. |

## 10. Recommended MVP slice

Name: **`adhd-policy serve --from <mcp.json>` (fan-in), stdio only, eager start.**

In: one process reads the entries of one `mcpServers` file (the same entries `init` handles), starts each upstream with its own declared `env` (this requires closing c6ca91d6 first), exposes tools as `<source>__<tool>`, runs the existing policy Layer per call, drops denied tools from `tools/list` (opt-in flag `--hide-denied`, default off so the D-08 behavior is unchanged), isolates upstream failure per source, tags logs by source. Out: everything in section 8.

Gherkin (user perspective, 7 scenarios):

```gherkin
Feature: One policy endpoint in front of several MCP servers

  Background:
    Given an mcp.json with servers "files", "git" and "web"
    And one policy file that allows "git__status" and denies "files__delete"

  Scenario: The agent sees one server with every tool prefixed by its source
    When I run "adhd-policy mcp-json init --fan-in" and restart my agent host
    Then my host lists one MCP server
    And its tools include "git__status" and "files__read" and no unprefixed names

  Scenario: A call reaches the right server
    When the agent calls "git__status"
    Then the "git" server answers and the "files" and "web" servers see nothing

  Scenario: A denied call is refused with the reason
    When the agent calls "files__delete"
    Then the call returns an error that names the denying rule
    And the "files" server never receives the call

  Scenario: Hiding denied tools shrinks the tool list
    Given I started the gateway with "--hide-denied"
    When my host lists tools
    Then "files__delete" is not listed
    And the tool list is smaller than the list without the flag

  Scenario: One server dying does not take the others down
    Given the "web" server process exits
    When the agent calls "git__status"
    Then it still succeeds
    And a call to a "web" tool returns an unavailable error naming "web"

  Scenario: Each server gets only its own environment
    Given "git" declares GIT_TOKEN and "web" declares WEB_KEY in mcp.json
    Then "git" can read GIT_TOKEN and cannot read WEB_KEY
    And "web" can read WEB_KEY and cannot read GIT_TOKEN

  Scenario: I can go back to per-server wrapping
    When I run "adhd-policy mcp-json init --undo"
    Then my original mcp.json is restored byte for byte
```

## 11. Recommendation: CONDITIONAL GO, narrowly; NO-GO as a context-or-RAM optimization

- **Do not market or justify this as a context or RAM feature.** Merging does not cut schemas, and hosts that matter already defer. The defensible value is **P2/P3: one enforcement and audit point, usable on hosts with no native deferral or hooks**, plus a place to put policy-filtered `tools/list`.
- **Cheapest first increments, in order:**
  1. Fix c6ca91d6 (env loss). It is a correctness bug on the shipped path and a prerequisite for fan-in.
  2. Read `docs/plan/policy-core/MEASUREMENTS.md` when it lands. If the single-wrapper baseline is small, the RAM argument is gone and fan-in rests on P2/P3 alone.
  3. Policy-filtered `tools/list` (`--hide-denied`) on the existing single wrapper. It delivers the only real context win to the shipped path and needs no gateway. Needs an `architect-decision` read on `listChanged` versus restart and on spec 2026-07-28.
  4. Only then a time-boxed spike of the MVP above, behind `architect-decision` (single-source assumption in `serveMcpPassthrough`, per-upstream supervision, spec-era compatibility) and a measurement run against section 9.
- Kill criteria: if step 2 shows the wrapper baseline is under the proposed threshold and the owner confirms the target hosts defer tools, close fan-in as DEFER and keep per-entry wrapping.

## 12. Open questions for the owner

1. Which hosts are in scope for the next quarter? If only Claude Code, fan-in's marginal value is mainly audit centralization; is that worth the single point of failure?
2. Is the real driver context size, RAM, or one place to change policy? The answer picks between step 3 (filtered list), the MVP, or nothing.
3. May denied tools be hidden from `tools/list` by default? It changes D-08 (denied tools stay listed) and removes the agent's ability to learn a tool exists but is blocked.
4. Wire name format: `<source>__<tool>` (matches MCPJungle, and keeps host globs per upstream) versus keeping `.` from the internal id. Both break GW-03 (names unchanged); accept that for the fan-in path only?
5. Is a single-process failure domain acceptable for credentials-heavy servers, or should fan-in exclude entries that carry secrets?
6. Do we want a meta/search tool at all, given native deferral on the main hosts, or is it a permanent non-goal?
7. Spec 2026-07-28 versus SDK v1 passthrough: do we commit to supporting both eras before adding any `listChanged`?

## Sources

Researcher survey (all fetched 2026-10-13): https://www.anthropic.com/engineering/advanced-tool-use ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ; https://www.anthropic.com/engineering/code-execution-with-mcp ; https://code.claude.com/docs/en/mcp ; https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/permissions ; https://developers.openai.com/api/docs/guides/tools-tool-search ; https://modelcontextprotocol.io/specification/2026-07-28/server/tools ; https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization ; https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices ; https://github.com/docker/mcp-gateway ; https://docs.docker.com/ai/mcp-gateway/ ; https://github.com/metatool-ai/metamcp ; https://github.com/mcpjungle/MCPJungle ; https://agentgateway.dev/docs/standalone/latest/mcp/connect/virtual/ ; https://github.com/lasso-security/mcp-gateway ; https://github.com/IBM/mcp-context-forge ; https://github.com/TBXark/mcp-proxy ; https://github.com/sparfenyuk/mcp-proxy ; https://github.com/microsoft/mcp-gateway ; https://arxiv.org/abs/2505.03275 ; https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks ; https://github.com/desty2k/mcp-benchmark.

Could not verify (carried from the survey): Smithery details; Docker `listChanged` and collision handling; MetaMCP and ContextForge prefixing; whether TBXark merges tools; Claude Code behavior behind a single gateway entry (inference); hook equivalents on non-Claude-Code hosts; any measured stdio server RSS.

Corrections found in the local research: Lasso exposes `get_metadata`/`run_tool` meta-tools, not `<server>_<tool>` names; the Docker row in LOCAL-RES omits dynamic tools, on-demand start and `--long-lived`/`--static`; its Claude Code permission and hook rows are now verified (name-level rules native, argument matching via hook).
