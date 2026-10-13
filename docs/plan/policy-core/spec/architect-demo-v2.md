# Architect demo v2: one policy, many tools, narrowing per dispatch

Design sketch for proposed products. Every command, file name, tool name and argument name is illustrative. Tool and argument names are written from general knowledge of those servers, not from their schemas; real bindings must be written against each server's actual schema. `policy-gw` and `sbx` do not exist yet.

## Model in brief

- A policy is a set of named constraints. Each constraint has a type (`NameSet`, `PathTree`, `Pattern`, `Bound`, `Flag`, `Opaque`) that implements `meet`, `subset` and `contains`. The engine core knows nothing about files, networks, agents or any tool.
- A binding maps a tool's argument (or a gateway-supplied context value) to a named constraint of one type.
- Layers resolve in order: global, project, agent definition, call scope. Each layer has `defaults` (overridable) and `ceiling` (only narrows).
- Call scope is an argument of the dispatch. It can only narrow, is recorded on the task, and is never written to any stored definition.
- Effective policy = cascade(defaults) intersected with every ceiling and with the caller's own authority.
- Enforcement happens at three points: the gateway (call-time), the tool itself (opaque caveats), and the kernel or process layer (ambient access, via each type's optional `compile`).

## File 1: policy.yaml (global, project and agents in one file)

```yaml
version: 1

# ---------------------------------------------------------------- bindings
# Tool arguments mapped to constraint types. Written once per server.
servers:
  github:
    bindings:
      - { tool: "*",            arg: repo,       constraint: github.repos,    type: NameSet }
      - { tool: "*",            ctx: tool_name,  constraint: github.ops,      type: NameSet }
      - { tool: create_branch,  arg: branch,     constraint: github.branches, type: Pattern }
  slack:
    bindings:
      - { tool: post_message,   arg: channel,    constraint: slack.post,      type: NameSet }
      - { tool: "*",            ctx: tool_name,  constraint: slack.tools,     type: NameSet }
      - { tool: post_message,   ctx: call_count_per_hour, constraint: slack.rate, type: Bound, direction: upper }
  browser:
    bindings:
      - { tool: browser_navigate, arg: url,      constraint: browser.urls,    type: Pattern }
      - { tool: "*",              ctx: tool_name, constraint: browser.tools,  type: NameSet }
      - { tool: browser_navigate, ctx: call_count, constraint: browser.navs,  type: Bound, direction: upper }
  k8s:
    bindings:
      - { tool: "*",            arg: namespace,  constraint: k8s.namespaces,  type: NameSet }
      - { tool: "*",            arg: kind,       constraint: k8s.kinds,       type: NameSet }
      - { tool: "*",            ctx: tool_name,  constraint: k8s.verbs,       type: NameSet }
      - { tool: scale,          arg: replicas,   constraint: k8s.max_replicas, type: Bound, direction: upper }
  stripe:
    bindings:
      - { tool: "*",            ctx: tool_name,  constraint: stripe.ops,      type: NameSet }
      - { tool: create_refund,  arg: amount,     constraint: stripe.max_amount, type: Bound, direction: upper }
      - { tool: create_refund,  arg: customer,   constraint: stripe.customers, type: NameSet }
      - { ctx: credential_mode,                  constraint: stripe.mode,     type: Flag }
  shell:
    bindings:
      - { tool: shell_execute,  arg: "command[0]", constraint: shell.commands, type: NameSet }
      - { tool: shell_execute,  arg: directory,    constraint: shell.cwd,      type: PathTree }
      - { tool: shell_execute,  arg: timeout,      constraint: shell.timeout,  type: Bound, direction: upper }
  fs:
    bindings:
      - { tool: [read_file, search_files],          arg: path, constraint: read,  type: PathTree }
      - { tool: [write_file, edit_file, move_file], arg: path, constraint: write, type: PathTree }
  agent:
    bindings:
      - { tool: agent,          arg: agent_name, constraint: agents, type: NameSet }
      - { tool: agent,          ctx: depth,      constraint: depth,  type: Bound, direction: upper }

# ------------------------------------------------------- global ceiling
# Only narrows. No lower layer, agent definition or call scope can lift it.
ceiling:
  read:            { deny: ["**/.ssh/**", "**/*.pem", "**/.env", "!**/.env.example"] }
  write:           { deny: [".git/hooks", ".mcp.json", "policy.yaml"] }
  github.ops:      { deny: [merge_pull_request, delete_branch, force_push] }
  slack.tools:     { deny: [search_messages] }          # results cross channel scope
  browser.tools:   { deny: [browser_evaluate] }
  k8s.kinds:       { deny: [secrets] }
  k8s.verbs:       { deny: [delete, exec] }
  stripe.mode:     test                                 # live mode needs an explicit project override
  shell.commands:  { deny: [sudo, ssh, curl, wget] }
  net:             { deny: [metadata] }                 # cloud metadata addresses, kernel-enforced

# --------------------------------------------- project defaults
# Used when a more specific layer says nothing. A layer below may override these.
defaults:
  read:            [., ../shared-types]
  write:           [.]
  net:             [registry.npmjs.org, github.com]
  agents:          [reviewer, qa, support, sre, release]
  depth:           2
  shell.commands:  [git, node, pnpm, rg, ls, cat, tsc]
  shell.cwd:       [.]
  shell.timeout:   120
  github.repos:    [acme/shop]
  github.ops:      [get_file, list_issues, create_issue, comment, create_pull_request]
  github.branches: ["feature/**"]
  slack.post:      ["#deploys"]
  slack.tools:     [post_message]
  slack.rate:      10
  browser.urls:    ["https://staging.shop.example/**"]
  browser.tools:   [browser_navigate, browser_click, browser_snapshot]
  browser.navs:    25
  k8s.namespaces:  [staging]
  k8s.kinds:       [pods, deployments]
  k8s.verbs:       [get, list, describe, logs]
  k8s.max_replicas: 5
  stripe.ops:      [list_customers, create_payment_link]
  stripe.max_amount: 5000
  stripe.customers: []

# ------------------------------------------ agent definitions (stored, never changed by dispatch)
agents:
  orchestrator:
    policy:
      agents:        [reviewer, qa, support, sre, release]
      write:         [.]
      shell.commands: [git, pnpm, rg, node, tsc]
  reviewer:
    policy:
      write:         []
      net:           []
      github.ops:    [get_file, comment]
      shell.commands: [rg, cat]
  qa:
    policy:
      write:         []
      browser.navs:  25
  support:
    policy:
      stripe.ops:    [list_customers, create_refund]
      stripe.max_amount: 5000
  sre:
    policy:
      k8s.verbs:     [get, list, describe, logs, scale]
  release:
    policy:
      slack.post:    ["#deploys"]
      github.ops:    [get_file, create_pull_request, comment]
```

## File 2: .mcp.json

Every server is wrapped by the gateway, which discovers `policy.yaml` itself (`./policy.yaml` for project and agent layers, `~/.config/policy/*.yaml` for the global layer). No `--policy` flag is required. The shell and browser are also confined by the sandbox for what the gateway cannot see. The shell is the existing `mcp-shell-server`.

```json
{
  "mcpServers": {
    "fs": {
      "command": "policy-gw",
      "args": ["--server", "fs", "--", "sbx", "run", "--", "npx", "@modelcontextprotocol/server-filesystem", "."]
    },
    "shell": {
      "command": "policy-gw",
      "args": ["--server", "shell", "--", "sbx", "run", "--", "uvx", "mcp-shell-server"]
    },
    "github": {
      "command": "policy-gw",
      "args": ["--server", "github", "--", "npx", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN_SCOPED}" }
    },
    "slack": {
      "command": "policy-gw",
      "args": ["--server", "slack", "--", "npx", "@modelcontextprotocol/server-slack"],
      "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" }
    },
    "browser": {
      "command": "policy-gw",
      "args": ["--server", "browser", "--", "sbx", "run", "--", "npx", "@playwright/mcp"]
    },
    "k8s": {
      "command": "policy-gw",
      "args": ["--server", "k8s", "--", "npx", "mcp-server-kubernetes"],
      "env": { "KUBECONFIG": "${KUBECONFIG_STAGING}" }
    },
    "stripe": {
      "command": "policy-gw",
      "args": ["--server", "stripe", "--", "npx", "@stripe/mcp", "--tools=all"],
      "env": { "STRIPE_SECRET_KEY": "${STRIPE_TEST_KEY}" }
    }
  }
}
```

## A dispatch with call scope

The orchestrator dispatches a QA agent for one task. The agent's definition is untouched.

```
agent({ agent_name: "qa",
        prompt: "Smoke-test checkout",
        scope: { "browser.urls": ["https://staging.shop.example/checkout/**"],
                 "browser.navs": 10, "read": ["src/checkout"], "net": [] } })
```

```
$ policy explain --agent qa --caller orchestrator --scope '...'
browser.urls   https://staging.shop.example/checkout/**   scope ∩ default
browser.navs   10                                         scope ≤ qa(25) ≤ default(25)
browser.tools  navigate, click, snapshot                  default; ceiling denies evaluate
write          (none)                                     qa definition
net            (none)                                     scope
enforced       gateway: browser.* ; kernel (sbx): read, write, net
```

Widening attempts are rejected at dispatch:

```
scope: { write: ["src"] }               -> denied: qa definition grants no write
scope: { read: ["../other-repo"] }      -> denied: outside caller's read authority
scope: { agents: ["release"] }          -> denied: qa cannot delegate
scope: { "browser.navs": 500 }          -> denied: exceeds caller's remaining budget
```

## Where each use case is solved

| Use case | Constraints used | Enforced by |
|---|---|---|
| Existing shell | `shell.commands`, `shell.cwd`, `shell.timeout` | Gateway for argv and cwd; sandbox for descendants, reads, network |
| GitHub | `github.repos`, `.ops`, `.branches` | Gateway, plus a scoped token |
| Slack | `slack.post`, `.tools`, `.rate` | Gateway; search denied by ceiling |
| Browser | `browser.urls`, `.tools`, `.navs` | Gateway for navigation; sandbox for network after the first page |
| Kubernetes | `k8s.namespaces`, `.kinds`, `.verbs`, `.max_replicas` | Gateway, plus RBAC on the kubeconfig |
| Stripe | `stripe.ops`, `.max_amount`, `.customers`, `.mode` | Gateway; mode via the injected test key |
| Dispatch | `agents`, `depth` | Gateway on the `agent` tool |

## What the gateway guarantees and does not

Claim to make: the policy layer authorizes every MCP tool call it mediates, against bindings it understands, and denies the rest. Containment of what tools do internally is the sandbox's job.

Limits:

1. **Only calls routed through it.** A server launched directly, or a host built-in tool such as a native Bash or file editor, is never seen by the gateway. Every server in `.mcp.json` must route through it, and host built-ins need a separate answer.
2. **Only what is visible in the call.** It authorizes arguments, not what the tool then does. An allowed `git` can still run hooks or aliases. An allowed URL can redirect. The sandbox covers the shell and browser for this reason.
3. **Authorization is not containment.** A denial stops only the calls the gateway mediates. A compromised server, or one holding a broad credential, is limited by scoped credentials and the kernel layer, not by the gateway.
4. **Unstructured arguments.** Free-text commands, raw manifests and SQL strings cannot be narrowed from outside. The policy can deny those tools or require an adapter that parses them first.
5. **Responses are not filtered.** The design checks requests. A permitted search can return data from outside the intended scope. Response filtering is a separate, unspecified feature.
6. **Other MCP surfaces.** Only tool calls are covered here. Resources, prompts and server-initiated requests such as sampling are separate message types; the gateway must handle or block each explicitly.
7. **Tools without bindings.** A call the gateway cannot interpret is denied under any restrictive policy. A new server stays unusable until its binding is written.
8. **Trust anchor.** The gateway and `policy.yaml` must not be writable by the agents they govern. The ceiling denies writes to `policy.yaml` and `.mcp.json`, and that rule must be enforced at the kernel layer, not only by the gateway.
9. **Check versus use.** A path or argument can change between the check and the server's use (for example a symlink swapped in). Only kernel-level enforcement closes this window.

## Caveats on this demo

- Package names, tool names and the Stripe `--tools=all` flag are from memory and unverified.
- The `ctx:` bindings (`tool_name`, `call_count`, `call_count_per_hour`, `credential_mode`, `depth`) assume the gateway supplies those values. That is a gateway feature to design, not an existing capability.
- The shell's `command[0]` binding assumes the tool's argument shape matches what the research recorded for the current server (`shell_execute`).
- Credentials matter in every row: the policy complements scoped tokens and does not replace them.
