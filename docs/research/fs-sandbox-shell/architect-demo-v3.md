# Architect demo v3: static permissions, dynamic session, query-engine filters

Design sketch for proposed products. Every command, file name, tool name and argument name is illustrative and written from general knowledge of those servers, not from their schemas. `policy-gw` and `sbx` do not exist yet.

## Principles taken from Hasura

| Hasura | This design |
|---|---|
| Permission = table x role x operation | Permission = tool x role |
| Row filter: a boolean expression over columns | `where`: a `@adhd/data-query-engine` filter evaluated over the tool call's arguments |
| Session variables referenced in filters | `$session.<name>` placeholders, supplied at dispatch |
| Column presets | `set`: arguments forced into the call |
| Role is a session variable | `role` is read from the session; it is never a key that structure hangs from |
| Rules are static, the session is dynamic | Permission files never change at dispatch; only the session does |

Agent definitions carry no policy. They name a role and may set session defaults. The dispatcher's session can only narrow. Nothing at dispatch edits a stored rule.

## How a call is evaluated

1. The gateway intercepts a tool call and builds a row: the call's arguments, plus a reserved `ctx` object the gateway supplies (`ctx.depth`, `ctx.calls`, `ctx.per_hour`, `ctx.mode`).
2. It selects the permissions whose `tool` matches and whose `role` includes `session.role`.
3. It substitutes each `$session.<name>` placeholder in the permission's `where` with the session's value. This happens in the policy layer, before the engine sees the filter. The engine never knows about sessions.
4. It evaluates the substituted `where` against the row with the query engine.
5. Decision: any matching `deny` wins, then any matching `ask` (sent to the host, fail-closed to deny), then any matching `allow`. No match means deny. `set` values are written into the call before it is forwarded.

Filter syntax is the query engine's own: `_eq`, `_ne`, `_in`, `_nin`, `_gt`, `_lt`, `_gte`, `_lte`, `_like`, `_ilike`, `_regex`, `_contains`, `_is_null`, combined with `_and`, `_or`, `_not`, and full dot notation for fields, including array elements (`command.0`) and nested objects.

## Session variables and narrowing

Variables are declared once with a type. The type defines what "narrower" means, and the check happens in the policy layer, outside the query engine.

| Type | A child's value must be |
|---|---|
| `paths` | Inside the parent's paths (after the gateway resolves real paths) |
| `names` | A subset of the parent's names |
| `number` | At most the parent's number |

A variable the child does not set is inherited from the parent. Layers (global, project) and the agent definition supply defaults; the dispatch narrows them.

## File 1: policy.yaml

```yaml
session:
  role:        name
  read_roots:  paths
  write_roots: paths
  repos:       names
  channels:    names
  customers:   names
  max_refund:  number

permissions:

  # ---- files and net (also compiled to the OS sandbox) ----
  - tool: files.read
    role: [orchestrator, reviewer, qa]
    where: { path: { _within: $session.read_roots } }

  - tool: files.write
    role: [orchestrator]
    where: { path: { _within: $session.write_roots } }

  - tool: files.*
    effect: deny
    where: { path: { _regex: '(^|/)\.env$|\.pem$|(^|/)\.ssh/|(^|/)\.git/hooks/|(^|/)\.mcp\.json$|(^|/)policy\.yaml$' } }

  - tool: net.connect
    where: { host: { _in: [registry.npmjs.org, github.com] } }

  - tool: net.connect
    effect: deny
    where: { host: { _in: [metadata] } }

  # ---- shell ----
  - tool: shell.shell_execute
    role: [orchestrator]
    where:
      _and:
        - { 'command.0':  { _in: [git, node, pnpm, rg, ls, cat, tsc] } }
        - { directory:    { _within: $session.write_roots } }
        - { timeout:      { _lte: 120 } }
    set: { timeout: 120 }

  - tool: shell.shell_execute
    role: [reviewer]
    where: { 'command.0': { _in: [rg, cat] } }

  - tool: shell.shell_execute
    effect: deny
    where: { 'command.0': { _in: [sudo, ssh, curl, wget] } }

  # ---- github ----
  - tool: github.comment
    role: [reviewer, release]
    where: { repo: { _in: $session.repos } }

  - tool: github.create_pull_request
    role: [release]
    where: { repo: { _in: $session.repos } }

  - tool: github.merge_pull_request
    role: [release]
    effect: ask
    where: { repo: { _in: $session.repos } }

  - tool: github.delete_branch
    effect: deny
  - tool: github.force_push
    effect: deny

  # ---- slack ----
  - tool: slack.post_message
    role: [release]
    where:
      _and:
        - { channel:      { _in: $session.channels } }
        - { 'ctx.per_hour': { _lt: 10 } }

  - tool: slack.search_messages
    effect: deny

  # ---- browser ----
  - tool: browser.browser_navigate
    role: [qa]
    where:
      _and:
        - { url:        { _like: 'https://staging.shop.example/%' } }
        - { 'ctx.calls': { _lt: 25 } }

  - tool: browser.browser_click
    role: [qa]
  - tool: browser.browser_snapshot
    role: [qa]
  - tool: browser.browser_evaluate
    effect: deny

  # ---- kubernetes ----
  - tool: k8s.[get, list, describe, logs]
    role: [sre]
    where: { namespace: { _eq: staging } }

  - tool: k8s.scale
    role: [sre]
    effect: ask
    where:
      _and:
        - { namespace: { _eq: staging } }
        - { replicas:  { _lte: 5 } }

  - tool: k8s.*
    effect: deny
    where: { _or: [ { kind: { _eq: secrets } }, { 'ctx.verb': { _in: [delete, exec] } } ] }

  # ---- stripe ----
  - tool: stripe.create_refund
    role: [support]
    effect: ask
    where:
      _and:
        - { customer:  { _in:  $session.customers } }
        - { amount:    { _lte: $session.max_refund } }
        - { 'ctx.mode': { _eq: test } }

  - tool: stripe.*
    effect: deny
    where: { 'ctx.mode': { _eq: live } }

  # ---- dispatch ----
  - tool: agent.agent
    role: [orchestrator]
    where:
      _and:
        - { agent_name:  { _in: [reviewer, qa, support, sre, release] } }
        - { 'ctx.depth': { _lt: 2 } }
```

## File 2: agents and session defaults

Agent definitions are small and hold no rules.

```yaml
orchestrator:
  role: orchestrator
  session: { read_roots: [., ../shared-types], write_roots: [.], repos: [acme/shop] }
reviewer:
  role: reviewer
  session: { read_roots: [src] }
qa:
  role: qa
  session: { read_roots: [., ../shared-types] }
support:
  role: support
  session: { customers: [cust_123], max_refund: 5000 }
sre:
  role: sre
release:
  role: release
  session: { repos: [acme/shop], channels: ['#deploys'] }
```

## File 3: .mcp.json

`policy-gw init` wraps the existing servers and backs up the original. The gateway discovers `policy.yaml` and the agent file itself, so no `--policy` flag is needed.

```json
{
  "mcpServers": {
    "shell":   { "command": "policy-gw", "args": ["--server", "shell",   "--", "sbx", "run", "--", "uvx", "mcp-shell-server"] },
    "github":  { "command": "policy-gw", "args": ["--server", "github",  "--", "npx", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN_SCOPED}" } },
    "slack":   { "command": "policy-gw", "args": ["--server", "slack",   "--", "npx", "@modelcontextprotocol/server-slack"] },
    "browser": { "command": "policy-gw", "args": ["--server", "browser", "--", "sbx", "run", "--", "npx", "@playwright/mcp"] },
    "k8s":     { "command": "policy-gw", "args": ["--server", "k8s",     "--", "npx", "mcp-server-kubernetes"] },
    "stripe":  { "command": "policy-gw", "args": ["--server", "stripe",  "--", "npx", "@stripe/mcp"], "env": { "STRIPE_SECRET_KEY": "${STRIPE_TEST_KEY}" } },
    "fs":      { "command": "policy-gw", "args": ["--server", "files",   "--", "sbx", "run", "--", "npx", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

## Dispatch with a narrowed session

```
agent({ agent_name: "reviewer",
        prompt: "Review checkout",
        session: { read_roots: ["src/checkout"], repos: ["acme/shop"] } })
```

Evaluation of three calls by that reviewer:

```
files.read { path: "src/checkout/cart.ts" }
  permission files.read: _within src/checkout        -> match
  deny regex                                         -> no match
  decision: allow

files.read { path: "src/checkout/../../.env" }
  gateway resolves the path to ".env"
  deny regex                                         -> match
  decision: deny (deny beats allow)

github.comment { repo: "acme/other" }
  permission github.comment: repo _in [acme/shop]    -> no match
  decision: deny (no matching allow)
```

Widening is rejected before the agent starts:

```
session.read_roots: ["../other-repo"]   rejected: outside the parent's read_roots
session.max_refund: 9000                rejected: exceeds the parent's 5000
session.role: orchestrator              rejected: role is not a narrowing of the parent's
```

## `ask`

```
support> stripe.create_refund { customer: cust_123, amount: 2500 }
  matches: stripe.create_refund (ask)  customer in session.customers, amount <= session.max_refund, ctx.mode = test
  -> host prompt: allow once / allow always for this role / deny   (no host or no answer = deny)
```

"Allow always" writes to a local user-only layer that agents cannot edit.

## `explain`

```
$ policy explain --agent reviewer --tool files.read --args '{"path":"src/checkout/cart.ts"}'
session  : role=reviewer read_roots=[src/checkout] (narrowed from [src])
matched  : permissions[0] files.read  allow   (_within src/checkout)
checked  : permissions[2] files.*     deny    (_regex ... no match)
decision : allow
```

## What the query engine provides and what it does not

- **Provided (confirmed in `src/lib/filters.ts`):** `_eq`, `_ne`, `_neq`, `_in`, `_nin`, `_gt`, `_lt`, `_gte`, `_lte`, `_like`, `_nlike`, `_ilike`, `_nilike`, `_regex`, `_iregex`, `_contains`, `_contained_in`, `_has_key`, `_is_null`, `_and`, `_or`, `_not`, dot-notation fields, and the README states that new operators are added in `filters.ts` and `operators.ts`.
- **One proposed extension: `_within`.** Directory containment has no operator today. It can be approximated with `_like` and a prefix pattern, but that is brittle around `..`, symlinks and trailing slashes. A `_within` operator (or the gateway normalizing paths before evaluation) is the clean route.
- **Not in the engine, by design:** `$session.*` substitution, `ctx` population, the narrowing check, effects, and `set`. All of these live in the policy layer.

## Gateway guarantees and limits

Claim to make: the policy layer authorizes every MCP tool call it mediates, against permissions it can evaluate, and denies the rest. Containment of what tools do internally is the sandbox's job.

1. **Only calls routed through it.** Servers launched directly, and host built-in tools, are not seen.
2. **Only what is visible in the call.** An allowed `git` can run hooks. An allowed URL can redirect. The sandbox covers shell and browser.
3. **Authorization is not containment.** A compromised server or a broad credential is limited by scoped credentials and the kernel layer, not the gateway.
4. **Unstructured arguments** (free text, raw manifests, SQL) cannot be filtered from outside. Deny those tools or add an adapter.
5. **Responses are not filtered.** A permitted search can return out-of-scope data.
6. **Other MCP surfaces** (resources, prompts, sampling) need explicit handling or blocking.
7. **Tools without a permission** are denied.
8. **Trust anchor.** `policy.yaml`, the agent file and `.mcp.json` must not be writable by governed agents. The deny rule on those paths must also be enforced at the kernel layer.
9. **Check versus use.** A path can change between the gateway's check and the server's use. Only kernel enforcement closes it.

## Open points

- **Implicit AND.** The examples use `_and` where several conditions must hold. Whether the engine treats multiple keys in one `where` object as AND should be confirmed before the file drops `_and`.
- **Tool-name lists** like `k8s.[get, list, ...]` and `tool: stripe.*` are a shorthand this design proposes; they are not part of the query engine.
- **`ctx` values** (`depth`, `calls`, `per_hour`, `mode`, `verb`) are gateway features to design.
- **Layer merge:** permission lists from global, project and local layers concatenate. Deny and ask are sticky; allow stays bounded by the dispatcher's session.
- **Where role defaults live** is decided here as the agent file. The alternative is a `session_defaults` list keyed by role inside the policy files.
- **Argument names and package names** are unverified against the real servers.
