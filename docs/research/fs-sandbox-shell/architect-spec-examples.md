# Architect spec: example hosts and example policies

Status: draft for owner review. These are example uses of the policy system and the sandbox. Neither tool's code references any host or tool named here, and the policy library does not authenticate callers or own sessions (SC-03). Recorded so the generic interfaces can be checked against real uses. Host integrations are separate deliverables owned by the host side. Companion to `architect-spec.md`.

## 1. Example consumer: dispatching agents through a host such as agent-mcp (DP)

These rows describe how an example host uses the system. They are not requirements on the `@adhd/policy` package, which has no reference to any host. Each row is satisfied by the host's own integration code (a separate deliverable) plus generic package features.

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| DP-01 | Dispatching an agent MUST be a governed tool call (`agent-mcp.agent`) with its own permission. | D4 > File 1 (who may create what) | S |
| DP-02 | Which agent names a caller may dispatch MUST be decided by a permission on `agent_name`. | D4 > File 1 | S |
| DP-03 | A dispatched agent MUST be sandboxed with the same rules as any other process. It has no policy of its own. | D4 > Trace | S |
| DP-04 | A dispatched agent's tools MUST come from the same `.mcp.json` entries, each served through an apigen `remote` or `bin` source with the policy Layer under the agent's attributes. There MUST NOT be a second server map. | D4 > File 2 | S |
| DP-05 | The existing hardcoded dispatch restrictions (allowed agents, depth, tool loops) are expressed as permissions on `agent-mcp.agent` and `runtime.depth`. | D3 > Principles; D4 > File 1 | S |
| DP-06 | agent-mcp MUST deliver the dispatched agent's attributes to the servers it starts for a task, through the channel its integration configures (DL-02). | D4 > Host contract and assumptions > 1 | U |
| DP-07 | agent-mcp MUST take its default servers from `.mcp.json`, not from a built-in catalog. | D4 > File 2 | U |
| DP-08 | A grant that widens beyond the dispatcher MUST be rejected before the agent starts. | D4 > Trace (second dispatch) | S |

## 2. Per-domain behaviors (TL)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| TL-01 | Files: reads MUST be limited to the caller's read roots plus shared read roots. Writes MUST be limited to write roots plus shared write roots. | D4 > File 1 (files) | S |
| TL-02 | Files: any path matching the secret and protected pattern list MUST be denied for read and write, in every root. | D4 > File 1 (files.* deny) | S |
| TL-03 | Files: only the orchestrator MAY write inside its own write roots. Reviewer and QA MUST have no write permission. | D4 > File 1 (files.write) | S |
| TL-04 | Net: connections MUST be limited to the allowed hosts, and metadata addresses MUST be denied. | D4 > File 1 (net) | S |
| TL-05 | Shell: the orchestrator MAY run only listed commands, within its write roots, with a timeout of at most 120, and the timeout MUST be forced to 120. | D4 > File 1 (shell) | S |
| TL-06 | Shell: reviewer MAY run only `rg` and `cat`. Commands such as `sudo`, `ssh`, `curl` and `wget` MUST be denied for every caller. | D4 > File 1 (shell) | S |
| TL-07 | GitHub: comment and PR creation MUST be limited to the caller's repos. Merge MUST require ask. Branch deletion and force push MUST be denied. | D4 > File 1 (github) | S |
| TL-08 | Slack: posting MUST be limited to the caller's channels and to fewer than 10 posts per hour. Searching MUST be denied. | D4 > File 1 (slack) | S |
| TL-09 | Browser: navigation MUST be limited to the staging origin and to fewer than 25 calls. Script evaluation MUST be denied. | D4 > File 1 (browser) | S |
| TL-10 | Kubernetes: reads MUST be limited to the staging namespace. Scaling MUST require ask and at most 5 replicas. Delete and exec MUST be denied. Any access to secrets MUST be denied. | D4 > File 1 (k8s) | S |
| TL-11 | Stripe: refunds MUST require ask, be limited to the caller's customers and maximum amount, and be allowed only in test mode. Everything MUST be denied in live mode. | D4 > File 1 (stripe) | S |
| TL-12 | Scoped credentials remain necessary. The policy complements them and MUST NOT be described as replacing them. | D2 > Caveats | S |

## 3. Example consumer: agent-mcp integration (PG)

Out of scope for the `@adhd/policy` package. Recorded so the package's generic interfaces are checked against a real host. The host-side integration is a separate, later deliverable that depends on `@adhd/policy`; nothing in the package may reference agent-mcp.

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PG-01 | The `@adhd/policy-core-client` library, the policy Layer and the CLI (compile, verify, explain, doctor) MUST be built and proven first, with no dependency on agent-mcp. | (new) | S |
| PG-02 | agent-mcp support MUST then be delivered as a plugin owned by the agent-mcp side, depending on `@adhd/policy` and loaded through agent-mcp's existing plugin entry mechanism (`plugins.entries`, `plugins.configPath`). agent-mcp core MUST NOT gain policy logic, and `@adhd/policy` MUST NOT gain agent-mcp code. | (new); `entrypoint/agent-mcp/src/config.ts` plugins | S |
| PG-03 | The plugin MUST compile the policy through the client's `compile` once at startup and reuse the memoized result (CC-01 to CC-03). | CC-03 | S |
| PG-04 | The plugin MUST enforce dispatch through `evaluate` and `narrow` for `agent-mcp.agent` calls, replacing the hardcoded depth, allowed-agent and tool-loop checks with permissions. | DP-01, DP-02, DP-05 | S |
| PG-05 | The plugin MUST give each dispatched task its attributes, and MUST start the wrapped sources and sandbox for the servers that task uses, from `.mcp.json`. | DP-03, DP-04, DP-06, DP-07 | U |
| PG-06 | Until the plugin is installed, agent-mcp behavior MUST be unchanged. | (new) | S |
| PG-07 | The plugin MUST pass the dispatched agent's name as an attribute and MUST NOT read policy from the agent definition. | SI-04 | S |
| PG-08 | The plugin MUST fail closed: if its policy cannot be loaded, dispatch is denied, not run under the old hardcoded limits silently. | FC-06 | S |
| PG-09 | Which agent-mcp hooks exist for intercepting dispatch, tool calls and task start MUST be confirmed against the plugin interface before the plugin is designed. If a needed hook is missing, the required agent-mcp change MUST be listed as a prerequisite item. | (new) | U |
| PG-10 | The plugin MUST not duplicate evaluation logic. All decisions MUST call the client from `@adhd/policy`. | CL-12 | S |
| PG-11 | The existing orchestrator policy store (`agent-core-policy`) is a different concept (seven policy types). The plugin MUST state how it relates (replace, delegate or coexist) before release. | (new) | O |

## Open decisions (EO)

| ID | Decision | Current default | Affects |
|---|---|---|---|
| OD-14 | How the plugin relates to `agent-core-policy`. | Undecided | PG-11 |
