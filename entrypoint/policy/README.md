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

These verbs load the apigen policy Layer in front of a command or server you do not control. `--spec <file>` (repeatable, layers by position global, project, local) names the policy; `--adhd-attributes <json|@file>` (else `ADHD_POLICY_ATTRIBUTES`) names who is asking. `--adhd-*` flags are consumed here and never reach the child; a flag value may not start with `--`, and `--adhd-attributes` / `--name` may be given once.

```bash
# Run one command; refused calls exit 3 and the command never starts
adhd-policy run bin:touch --spec gate.yaml --adhd-attributes @attrs.json -- file.txt

# Serve an upstream MCP server (stdio) behind the policy; refusals reach the host as isError tool results
adhd-policy serve bin:node --spec gate.yaml -- ./server.js

# Name the source: operation ids are <name>/<tool> and the MCP tool names the host sees are <name>_<tool> (default name: the command's basename; never the upstream's own self-declared name)
adhd-policy serve bin:node --name notes --spec gate.yaml -- ./server.js

# Point an existing .mcp.json entry at `adhd-policy serve`, and put it back byte for byte
adhd-policy mcp-json init --spec gate.yaml
adhd-policy mcp-json --undo
```

`serve` fronts the upstream through a gateway and ends when the host closes stdin or the transport, or on SIGINT / SIGTERM; the upstream's whole process group is stopped and the exit code is 0. An upstream that fails its startup handshake makes `serve` exit non-zero before it serves anything. An upstream that crashes while serving is restarted up to 5 times; calls made while it is down return an `isError` result, and once the restarts are used up they keep doing so until the host disconnects. `run` is traced like the servers (one span per dispatched operation). The upstream sees only `PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL` from the environment: variables set in a wrapped `.mcp.json` entry's `env` belong to the `adhd-policy` process and are not forwarded to the upstream.

### `mcp-json`

| Command | Effect |
|---|---|
| `mcp-json init --spec <f> [--file <p>] [--only <name>]... [--replace]` | wraps stdio entries (`--file` defaults to `.mcp.json`). A relative `--spec` is stored relative to the `.mcp.json`'s directory, an absolute one as given. An `--only` name that matches no entry exits 2 and writes nothing. An entry already wrapped under a different spec is reported (with the old spec, on stderr and in `skipped`) and left alone; `--replace` rewrites its spec. A second `init` changes nothing |
| `mcp-json --undo [--file <p>] [--force]` | restores the original byte for byte, but only while the file is still what `init` wrote; a file edited since (or with no record) exits 2 and is left alone, and `--force` restores the backup anyway |

`init` writes three files with atomic replace: the file itself (its permission bits are kept), `<file>.adhd-policy.bak` (the original, mode `0600`) and `<file>.adhd-policy.json` (mode `0600`, the SHA-256 of what `init` wrote, which is how `--undo` detects edits).

## Trust: who is asking

The attributes name the caller (`role`, `read_roots`, ...) and the policy decides on them, so they are only as trustworthy as their source. `--adhd-attributes` and `ADHD_POLICY_ATTRIBUTES` are self-asserted by whoever launches `adhd-policy`; they are not authentication. The source must therefore be outside the control of the process being gated: a root-owned or launcher-owned `@file`, or a flag set by the host that starts the wrapper, never a file or environment the gated command or model can write. The gated child never receives `ADHD_POLICY_ATTRIBUTES` or any `--adhd-*` flag (its environment is the allowlist above). A caller cannot supply its own attributes through a tool call: the attributes layer writes them to the call context on every call and the policy Layer reads only that, never anything the tool call carried. The policy file itself (`--spec`, `ADHD_POLICY_FILES`, a discovered `workspace-policy.yaml`) is equally trusted input; project policy discovery stops at your home directory and never adopts a file above it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success: `check` allowed, `verify` / `doctor` found no failure, `evaluate` returned a decision (any decision, a deny included), `serve` shut down cleanly; `run` returns the command's own status |
| 1 | internal error, or the policy could not be loaded (every operation fails closed, never allows), or a source could not start |
| 2 | invalid input (unknown or valueless flag, bad JSON, a port outside 0..65535, `--only` naming nothing, `--undo` on a modified file), or `verify` / `compile` / `doctor` reported failures |
| 3 | `check`, `run` or `serve` refused the call (deny or ask) |
| 4 | not found (no `.mcp.json`, no backup) |

## Settings

| Variable | Meaning |
|---|---|
| `ADHD_POLICY_FILES` | explicit policy layer files (comma-separated), overriding discovery |
| `ADHD_POLICY_ATTRIBUTES` | caller attributes when no `--adhd-attributes` flag is given |
| `ADHD_POLICY_HTTP_PORT` | port of `adhd-policy-http`; whole number 0..65535, `0` (default) asks the OS; anything else exits 2 |
| `ADHD_POLICY_LOG_LEVEL` | `debug`, `info`, `warn` (default for the command line), `error`, `silent` |
| `ADHD_POLICY_TELEMETRY` | `off` silences metrics and event logs; anything else (default) writes them to `~/.adhd/sox-ecosystem/policy/logs`, rotating at 100 MB per file |

## Build

`nx build policy` bundles the three bins and bakes `dist/api.ir.json` (the extracted operation surface) beside them, so start-up does not run the TypeScript extractor. If the shipped artifact is stale or mismatched, one line on stderr says so and the surface is extracted live. `nx run policy:verify-dist-load` loads the three bins.
