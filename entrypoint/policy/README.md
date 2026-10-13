# @adhd/policy

Policy for tool calls. Three bins over [`@adhd/policy-core-client`](../../packages/policy/policy-core-client): a command line, an MCP server and a loopback HTTP server. Each entry file is a few lines that call into `src/wrapper`; the wrapper adds no behaviour of its own, apigen derives the commands, flags, validation and exit codes from the client's operations.

```bash
npm install -g @adhd/policy
```

| Bin | What it starts |
|---|---|
| `adhd-policy` | the command line (`check`, `evaluate`, `explain`, `resolve`, `narrow`, `compile`, `verify`, `show`, `doctor`, `draft`) |
| `adhd-policy-mcp` | the same operations as MCP tools over stdio (`policy_check`, ...), explicit start only |
| `adhd-policy-http` | the same operations over HTTP on `127.0.0.1` (`ADHD_POLICY_HTTP_PORT`, `0` = ephemeral port); a non-loopback host is refused |

## Calling convention

Every operation takes one JSON object, passed as `--input '<json>'`. There are no per-field flags and `--input @file` is not supported. Operations whose input is all optional (`verify`, `compile`, `resolve`, `show`, `doctor`) need no `--input`.

```bash
adhd-policy check --input '{"tool":"files.read","args":{"path":"/work/readme.md"},"attributes":{"role":"dev","read_roots":["/work"]}}'
adhd-policy verify
```

The policy is found by walking up from the working directory for `workspace-policy.yaml` (then the user-global `global.yaml`, then a built-in deny-all default). The source is announced once on stderr as `policy: <path>`; `ADHD_POLICY_FILES` overrides discovery.

## Fronting an unmodified command or MCP server

These verbs load the apigen policy Layer in front of a command or server you do not control. `--spec <file>` (repeatable, layers by position global, project, local) names the policy; `--adhd-attributes <json|@file>` (else `ADHD_POLICY_ATTRIBUTES`) names who is asking. `--adhd-*` flags are consumed here and never reach the child.

```bash
# Run one command; refused calls exit 3 and the command never starts
adhd-policy run bin:touch --spec gate.yaml --adhd-attributes @attrs.json -- file.txt

# Serve an upstream MCP server (stdio) behind the policy; refusals reach the host as isError tool results
adhd-policy serve bin:node --spec gate.yaml -- ./server.js

# Point an existing .mcp.json entry at `adhd-policy serve`, and put it back byte for byte
adhd-policy mcp-json init --spec gate.yaml
adhd-policy mcp-json --undo
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `check` allowed; any other operation succeeded (`evaluate` returns the decision as JSON and exits 0 even for a deny); `verify` found no errors |
| 2 | invalid input, or `verify` / `compile` reported errors |
| 3 | `check` refused the call (deny or ask) |
| 1 | the policy could not be loaded: every operation fails closed, never allows |

## Build

`nx build policy` bundles the three bins and bakes `dist/api.ir.json` (the extracted operation surface) beside them, so start-up does not run the TypeScript extractor. `nx run policy:verify-dist-load` checks the bins.
