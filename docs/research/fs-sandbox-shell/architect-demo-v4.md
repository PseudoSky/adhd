# Architect demo v4: context and args filters, declared handoff

Design sketch for proposed products. Every command, file name, tool name and argument name is illustrative and written from general knowledge of those servers, not from their schemas. `policy-gw` and `sbx` do not exist yet.

## Reference vocabulary

A permission has two filters, written in `@adhd/data-query-engine` syntax.

| Key | Evaluated over | Notes |
|---|---|---|
| `tool` | The tool name (one or a list) | `namespace.tool`; `*` allowed |
| `context` | The caller's session: `role`, the declared variables, and `runtime` | Addressed directly: `role`, `repos`, `runtime.depth` |
| `args` | The tool call's arguments | Bare argument names; dot notation for nested arguments such as `grant.read_roots` |
| `grant`, `only` | Arguments of the child-creating tools (`agent-mcp.agent`, `sandbox.mount`, `sandbox.exec`): partial sessions. `grant` adds to the child's session, `only` restricts it | See the merge rules below |
| `child.<name>` | Added to the row for those tools by the gateway: the child's completed session after the merge | Used by the narrowing rule |
| `$session.<name>` | A value from the caller's session, substituted into an `args` filter before it runs | The only place the two meet |
| `effect` | `allow` (default), `ask` or `deny` | Deny beats ask beats allow; no match means deny |
| `set` | Arguments forced into an allowed call | |

A permission applies when the tool matches and both filters are true. An omitted filter is true.

`runtime` is part of the session but is maintained by the gateway and cannot be set by a grant:

| Field | Meaning |
|---|---|
| `runtime.depth` | Dispatch and sandbox levels deep |
| `runtime.calls` | Calls this session has made to the tool being evaluated |
| `runtime.per_hour` | The same, over the last hour |
| `runtime.mode` | `test` or `live`, from the credential the gateway injected |

## How session variables reach execution

A session variable can go to three places, and `handoff` declares which.

| Destination | Meaning | Process cooperation needed |
|---|---|---|
| `sandbox.read`, `sandbox.write` | The kernel sandbox's read and write scope | None |
| `argv`, `env`, `cwd` | A launch argument, environment variable or working directory of one target | None |
| `arg.session_ref` | An opaque reference to the child's session, added to the call that creates a child | The host passes it on when spawning |

A variable no `handoff` entry names stays in the gateway. The process never sees it.

Each entry has an optional selector (`target` for a server at launch, `tool` for a call), a `from` (a session variable) and a `to`. No selector means every spawned process.

Rules:

1. **Merging a child's session, per variable.** The child's own specification is its layered `session_defaults` (global, then project, then the role's entry; the more specific entry wins per variable; an entry without `role` applies to every role). The parent's contribution is the call's `grant` (adds) and `only` (restricts), applied in that order.

   | Child specifies it | Parent's `grant` sets it | Result of the add step |
   |---|---|---|
   | no | no | Inherited from the parent's session |
   | no | yes | The parent's value |
   | yes | no | The child's own value |
   | yes | yes | Union of the child's value and the parent's value |

   Then `only`, if present for that variable, must lie within the add step's result and replaces it. Union is a set union for `paths` and `names`, and the larger value for `number`. The final result is the completed child session (`child.*`). It must fit within the parent's own session, so a parent can only give a child what it has itself. The narrowing rule checks that, and `handoff` reads the completed session. A role that must not inherit a variable specifies it explicitly, for example `write_roots: []`.
2. **References, not values.** The gateway issues a `session_ref` only for a grant it allowed. The host passes it to the gateways it starts for that child as `POLICY_SESSION_REF`, and each gateway resolves it with its parent gateway. A process can only hold references the gateway issued, so it cannot start a child with a wider session.
3. **Root session.** With no reference, the gateway builds the session from `root` and `session_defaults`.
4. **Absolute paths.** Only the global layer or a local user layer may introduce an absolute path into a session. A project file may not, because it is committed and shared. A `grant` or `only` may contain an absolute path only if it lies within the parent's session. The gateway resolves real paths on both sides before comparing (on macOS `/tmp` is a link to `/private/tmp`).
5. **Fail closed on unchecked variables.** The gateway denies any key in `grant` or `only` that no narrowing check covers, so a variable added later cannot be set unchecked.

## File 1: policy.yaml

```yaml
root: orchestrator

session:
  role:        name
  read_roots:  paths
  write_roots: paths
  repos:       names
  channels:    names
  customers:   names
  max_refund:  number
  shared_read_roots:  paths       # set only in the global layer; every agent inherits them
  shared_write_roots: paths
  runtime:                       # supplied and updated by the gateway; read-only
    depth:     number
    calls:     number
    per_hour:  number
    mode:      name

# layered defaults: files at the global and project layers concatenate; an entry without `role`
# applies to every role; the more specific entry wins per variable
session_defaults:
  - { session: { role: orchestrator, read_roots: [., ../shared-types], write_roots: [.], repos: [acme/shop] } }
  - { session: { role: reviewer,     read_roots: [src], write_roots: [], repos: [acme/shop] } }
  - { session: { role: qa,           read_roots: [., ../shared-types], write_roots: [] } }
  - { session: { role: support,      read_roots: [], write_roots: [], customers: [cust_123], max_refund: 5000 } }
  - { session: { role: sre,          read_roots: [], write_roots: [] } }
  - { session: { role: release,      read_roots: [], write_roots: [], repos: [acme/shop], channels: ['#deploys'] } }

handoff:
  # kernel confinement of every spawned process, from the variables the filters use
  - { from: read_roots,         to: sandbox.read }
  - { from: write_roots,        to: sandbox.write }
  - { from: shared_read_roots,  to: sandbox.read }       # entries to one destination accumulate
  - { from: shared_write_roots, to: sandbox.write }

  # launch bindings for specific servers
  - { target: files, from: read_roots,        to: argv }  # the filesystem server takes its roots as arguments
  - { target: files, from: shared_read_roots, to: argv }
  - { target: shell, from: read_roots, to: cwd }         # first element becomes the working directory

  # the completed child session travels as an opaque reference
  - { tool: [agent-mcp.agent, sandbox.mount, sandbox.exec], from: child, to: arg.session_ref }

permissions:

  # ---- creating children: narrowing, written once (child.* is the completed session) ----
  - tool: [sandbox.mount, sandbox.exec, agent-mcp.agent]
    effect: deny
    args:
      _not:
        _and:
          - { 'child.read_roots':         { _within: $session.read_roots } }
          - { 'child.write_roots':        { _within: $session.write_roots } }
          - { 'child.shared_read_roots':  { _within: $session.shared_read_roots } }
          - { 'child.shared_write_roots': { _within: $session.shared_write_roots } }
          - { 'child.repos':              { _contained_in: $session.repos } }
          - { 'child.channels':           { _contained_in: $session.channels } }
          - { 'child.customers':          { _contained_in: $session.customers } }
          - { 'child.max_refund':         { _lte: $session.max_refund } }

  - tool: [sandbox.mount, sandbox.exec, agent-mcp.agent]
    effect: deny
    context: { 'runtime.depth': { _gte: 2 } }

  # ---- creating children: who may create what ----
  - tool: agent-mcp.agent
    context: { role: { _eq: orchestrator } }
    args:    { agent_name: { _in: [reviewer, qa, support, sre, release] } }

  - tool: sandbox.mount
    context: { role: { _eq: orchestrator } }
    args:    { server: { _in: [github, slack, k8s] } }

  - tool: sandbox.mount
    context: { role: { _eq: qa } }
    args:    { server: { _eq: browser } }

  - tool: sandbox.mount
    context: { role: { _eq: support } }
    args:    { server: { _eq: stripe } }

  - tool: sandbox.exec
    context: { role: { _eq: orchestrator } }
    args:    { bin: { _in: [rg, node, pnpm] } }

  # ---- files and net ----
  - tool: files.read
    context: { role: { _in: [orchestrator, reviewer, qa] } }
    args:    { path: { _within: $session.read_roots } }

  - tool: files.write
    context: { role: { _eq: orchestrator } }
    args:    { path: { _within: $session.write_roots } }

  # shared folders: no context filter, so every role; set once in the global layer
  - tool: files.read
    args: { path: { _within: $session.shared_read_roots } }

  - tool: files.write
    args: { path: { _within: $session.shared_write_roots } }

  - tool: files.*
    effect: deny
    args: { path: { _regex: '(^|/)\.env$|\.pem$|(^|/)\.ssh/|(^|/)\.git/hooks/|(^|/)\.mcp\.json$|(^|/)policy\.yaml$' } }

  - tool: net.connect
    args: { host: { _in: [registry.npmjs.org, github.com] } }

  - tool: net.connect
    effect: deny
    args: { host: { _in: [metadata] } }

  # ---- shell ----
  - tool: shell.shell_execute
    context: { role: { _eq: orchestrator } }
    args:
      _and:
        - { 'command.0': { _in: [git, node, pnpm, rg, ls, cat, tsc] } }
        - { directory:   { _within: $session.write_roots } }
        - { timeout:     { _lte: 120 } }
    set: { timeout: 120 }

  - tool: shell.shell_execute
    context: { role: { _eq: reviewer } }
    args:    { 'command.0': { _in: [rg, cat] } }

  - tool: shell.shell_execute
    effect: deny
    args: { 'command.0': { _in: [sudo, ssh, curl, wget] } }

  # ---- github ----
  - tool: github.comment
    context: { role: { _in: [reviewer, release] } }
    args:    { repo: { _in: $session.repos } }

  - tool: github.create_pull_request
    context: { role: { _eq: release } }
    args:    { repo: { _in: $session.repos } }

  - tool: github.merge_pull_request
    effect: ask
    context: { role: { _eq: release } }
    args:    { repo: { _in: $session.repos } }

  - tool: [github.delete_branch, github.force_push]
    effect: deny

  # ---- slack ----
  - tool: slack.post_message
    context:
      _and:
        - { role:               { _eq: release } }
        - { 'runtime.per_hour': { _lt: 10 } }
    args: { channel: { _in: $session.channels } }

  - tool: slack.search_messages
    effect: deny

  # ---- browser ----
  - tool: browser.browser_navigate
    context:
      _and:
        - { role:            { _eq: qa } }
        - { 'runtime.calls': { _lt: 25 } }
    args: { url: { _like: 'https://staging.shop.example/%' } }

  - tool: [browser.browser_click, browser.browser_snapshot]
    context: { role: { _eq: qa } }

  - tool: browser.browser_evaluate
    effect: deny

  # ---- kubernetes ----
  - tool: [k8s.get, k8s.list, k8s.describe, k8s.logs]
    context: { role: { _eq: sre } }
    args:    { namespace: { _eq: staging } }

  - tool: k8s.scale
    effect: ask
    context: { role: { _eq: sre } }
    args:
      _and:
        - { namespace: { _eq: staging } }
        - { replicas:  { _lte: 5 } }

  - tool: [k8s.delete, k8s.exec]
    effect: deny

  - tool: k8s.*
    effect: deny
    args: { kind: { _eq: secrets } }

  # ---- stripe ----
  - tool: stripe.create_refund
    effect: ask
    context:
      _and:
        - { role:           { _eq: support } }
        - { 'runtime.mode': { _eq: test } }
    args:
      _and:
        - { customer: { _in:  $session.customers } }
        - { amount:   { _lte: $session.max_refund } }

  - tool: stripe.*
    effect: deny
    context: { 'runtime.mode': { _eq: live } }
```

## File 1b: global layer, `~/.config/policy/global.yaml`

Machine-specific, so it is the only place absolute paths are introduced. Every agent inherits these through the merge rule. A role that must not have them sets `shared_read_roots: []` in its own `session_defaults` entry.

```yaml
session_defaults:
  - session:
      shared_read_roots:  [/Users/me/docs, /usr/local/share/schemas]
      shared_write_roots: [/tmp/agents]
```

The `files.*` deny entry still applies, so a shared folder cannot expose `.env`, `.pem` or `.ssh` files.

## File 2: .mcp.json

Unchanged from the previous version. Each server is wrapped by `policy-gw`, which discovers `policy.yaml` itself.

```json
{
  "mcpServers": {
    "files":     { "command": "policy-gw", "args": ["--server", "files",     "--", "sbx", "run", "--", "npx", "@modelcontextprotocol/server-filesystem"] },
    "shell":     { "command": "policy-gw", "args": ["--server", "shell",     "--", "sbx", "run", "--", "uvx", "mcp-shell-server"] },
    "github":    { "command": "policy-gw", "args": ["--server", "github",    "--", "npx", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN_SCOPED}" } },
    "slack":     { "command": "policy-gw", "args": ["--server", "slack",     "--", "npx", "@modelcontextprotocol/server-slack"],  "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" } },
    "browser":   { "command": "policy-gw", "args": ["--server", "browser",   "--", "sbx", "run", "--", "npx", "@playwright/mcp"] },
    "k8s":       { "command": "policy-gw", "args": ["--server", "k8s",       "--", "npx", "mcp-server-kubernetes"],               "env": { "KUBECONFIG": "${KUBECONFIG_STAGING}" } },
    "stripe":    { "command": "policy-gw", "args": ["--server", "stripe",    "--", "npx", "@stripe/mcp"],                         "env": { "STRIPE_SECRET_KEY": "${STRIPE_TEST_KEY}" } },
    "sandbox":   { "command": "policy-gw", "args": ["--server", "sandbox",   "--", "sbx", "serve"] },
    "agent-mcp": { "command": "policy-gw", "args": ["--server", "agent-mcp", "--", "sbx", "run", "--", "npx", "@adhd/agent-mcp"] }
  }
}
```

The `files` entry has no root argument. The `handoff` entry for `files` appends the session's `read_roots` to the arguments at launch.

## Trace: a dispatch and its handoff

The orchestrator dispatches a reviewer, adding a directory:

```
agent-mcp.agent { agent_name: "reviewer", prompt: "Review checkout",
                  grant: { read_roots: ["tests/fixtures"] } }

completed child session, per variable:
  read_roots          reviewer specifies [src], grant adds [tests/fixtures]   -> union: [src, tests/fixtures]
  write_roots         reviewer specifies [], not granted                      -> reviewer's own: []
  repos               reviewer specifies [acme/shop], not granted             -> reviewer's own: [acme/shop]
  channels            reviewer does not specify, not granted                  -> inherited from the orchestrator: []
  shared_read_roots   reviewer does not specify, not granted                  -> inherited: [/Users/me/docs, /usr/local/share/schemas]
  shared_write_roots  reviewer does not specify, not granted                  -> inherited: [/tmp/agents]

deny: narrowing    every child.* within the caller's session                  not matched
deny: depth        runtime.depth 0 >= 2 ✗                                     not matched
allow: orchestrator may dispatch reviewer                                     MATCH
decision: ALLOW

handoff for this call:
  child -> arg.session_ref   the gateway issues ref r7 for the completed session and adds
                             session_ref: "r7" to the call it forwards to agent-mcp
```

A second dispatch restricts instead of adding:

```
agent-mcp.agent { agent_name: "reviewer", prompt: "Review the cart only",
                  only: { read_roots: ["src/checkout"], shared_write_roots: [] } }

read_roots          add step [src] (no grant); only [src/checkout] is within [src]          -> [src/checkout]
shared_write_roots  add step inherited [/tmp/agents]; only [] is within it                  -> []
decision: ALLOW

agent-mcp.agent { agent_name: "reviewer", only: { read_roots: ["docs"] } }
  only [docs] is not within the add step's [src]                                           DENY
agent-mcp.agent { agent_name: "reviewer", grant: { max_refund: 9000 } }
  child.max_refund 9000 exceeds the caller's session                                       DENY
agent-mcp.agent { agent_name: "reviewer", grant: { unknown_var: [x] } }
  no narrowing check covers unknown_var                                                    DENY (fail closed)
```

agent-mcp starts the first reviewer's servers from `.mcp.json`, passing `POLICY_SESSION_REF=r7` to each gateway. Each gateway resolves `r7` with its parent and applies `handoff`:

```
files   argv   read_roots + shared_read_roots -> server-filesystem /Users/me/code/shop/src /Users/me/code/shop/tests/fixtures /Users/me/docs /usr/local/share/schemas
files   kernel sandbox.read  [src, tests/fixtures, /Users/me/docs, /usr/local/share/schemas]
        kernel sandbox.write [/tmp/agents]
shell   cwd    read_roots[0] -> /Users/me/code/shop/src
shell   kernel sandbox.read  (same as files)   sandbox.write [/tmp/agents]
github  (no handoff entry; repos stays in the gateway)
```

The reviewer's calls are then evaluated under that session:

```
files.read   { path: "tests/fixtures/a.json" }          ALLOW  (context: role reviewer; args: path within read_roots)
files.read   { path: "/Users/me/docs/guide.md" }        ALLOW  (no context filter; args: path within shared_read_roots)
files.read   { path: "/Users/me/docs/.env" }            DENY   (files.* deny regex beats the allow)
files.write  { path: "/tmp/agents/scratch.txt" }        ALLOW  (shared_write_roots, every role)
files.write  { path: "src/cart.ts" }                    DENY   (no allow for reviewer; kernel write scope is only /tmp/agents)
github.comment { repo: "acme/other" }                   DENY   (args: repo not in session.repos)
```

## Host contract and assumptions

1. **The host passes `session_ref` on.** When agent-mcp starts servers for a dispatched task, it sets `POLICY_SESSION_REF` from the `session_ref` it received with the dispatch call. That's a small change to agent-mcp that the config alone cannot do.
2. **A completed child session that exceeds the parent's session** (a child's own value, or a union) makes the dispatch fail the narrowing rule. The alternative is to clamp to the intersection, which needs the gateway to compute an intersection and not only check one. Not decided.
3. **`grant` and `only` for the same variable** are both allowed: `grant` first, then `only`. It reads as "add this, then restrict to that", and it is an easy place to confuse a reader.
4. **The reference is opaque and issued only for allowed grants.** Whether references are single-use, expire with the task, or can be revoked is undesigned.
5. **`handoff` destinations are a closed set** (`sandbox.read`, `sandbox.write`, `argv`, `env`, `cwd`, `arg.*`). A target that needs a value in a different shape needs a new destination or a wrapper.
6. **`cwd` takes the first element** of a list. A role with several read roots gets the first one.
7. **A variable not named by `handoff` is never given to a process.** That's intended, but a server that needs something like `repos` to filter its own behavior won't receive it, and has to be filtered at the gateway.
8. **`_within` over lists** meaning "every element inside" is the one proposed engine extension. `_contained_in`, `_not` and `_and` are existing operators.
9. **`POLICY_SESSION_REF` is an environment channel, not a feature toggle.** It carries identity to the gateway, not an on/off switch.
10. **The gateway limits** from earlier demos still apply: only mediated calls, no response filtering, unstructured arguments, and kernel-only bounds below the first sandbox.
11. **Shared write folders are shared state.** Every agent can write the same `/tmp/agents`, including parallel ones. That is probably intended, but one agent can affect another.
12. **`shared_*` roots are ordinary variables.** A role can drop them with an explicit empty list, and a parent can restrict them with `only`. If they must be non-removable, they would need to move out of session variables into fixed permission and `handoff` entries, which loses per-child restriction.
