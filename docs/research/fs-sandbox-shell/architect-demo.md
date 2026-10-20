# Architect demo: how a user would use each variant

Design sketch for proposed products. Every command, file name and package name is illustrative; none of it exists yet.

Scenario: you run an AI coding agent in any MCP-capable host on your laptop, working in `~/code/shop`.

## Policy discovery (applies to every variant)

Every tool finds its policy itself. `--policy` is an override, not a requirement. Resolution order, first match wins:

1. `--policy <file>` on the command line
2. `workspace-policy.yaml` in the current directory, then each parent directory up to the home directory
3. `~/.config/workspace-policy/default.yaml` (your personal defaults)
4. The built-in default: the launch directory as the only read-write root, workspace-only reads, sensitive-file refusal, protected paths, no network egress except the package registries, metadata addresses blocked

Because rung 4 always exists, a tool with no flags and no file is still confined. Tools print the policy source they used on startup (`policy: ./workspace-policy.yaml`), and `sbx policy show` prints the fully resolved result.

The working directory is also defaulted: tools use the directory the host launches them from as the workspace root, so repo-local config needs no path arguments.

## The shared piece: an optional policy file

You only write this file when the built-in default is not what you want:

```yaml
roots:
  - path: .
    mode: rw
read:
  scope: workspace-only
  sensitive: ["*.env", "*.env.*", "**/*.pem", "~/.ssh/**", "!*.env.example"]
protected: [".git/hooks", ".mcp.json", ".zshrc"]
egress:
  allow: ["registry.npmjs.org", "github.com"]
  block_metadata: true
credentials:
  deny: [AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN]
limits: { wall_seconds: 120, output_bytes: 1000000 }
```

## Variant A: compiler and launcher only

You keep the shell and fs servers you already use. The launcher wraps them in the OS sandbox.

Before, in your host's MCP config:

```json
{ "mcpServers": {
  "fs":    { "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "."] },
  "shell": { "command": "uvx", "args": ["mcp-shell-server"] }
}}
```

After (policy found automatically):

```json
{ "mcpServers": {
  "fs":    { "command": "sbx", "args": ["run", "--", "npx", "@modelcontextprotocol/server-filesystem", "."] },
  "shell": { "command": "sbx", "args": ["run", "--", "uvx", "mcp-shell-server"] }
}}
```

Override example, when you want a specific policy: `["run", "--policy", "ci-policy.yaml", "--", ...]`.

What you notice in use:
- The agent runs `cat ../other-repo/.env` through the shell and gets "denied by policy", not the file.
- The fs tool's read of the same file is denied by the same rule.
- `sbx verify` runs a built-in proof that the shell and fs answers match across about 30 cases (symlink out of the repo, writing `.git/hooks`, a request to a cloud metadata address).
- `sbx violations --last` shows what the sandbox blocked, so you can widen the policy deliberately.

Good for: you like your current servers and want real confinement. Limit: you still depend on those servers' bugs and features.

## Variant B: A plus a shell server

You replace the third-party shell server with ours. It always runs inside the sandbox.

```json
{ "mcpServers": {
  "fs":    { "command": "sbx", "args": ["run", "--", "npx", "@modelcontextprotocol/server-filesystem", "."] },
  "shell": { "command": "shell-mcp" }
}}
```

`shell-mcp` takes no arguments in the normal case. It discovers the policy, confines itself, and uses the launch directory as its working directory. Optional overrides: `--policy <file>`, `--cwd <dir>`.

What you notice in use:
- Every result carries a real exit code, a signal if any, a truncated flag and the duration. Agents stop guessing whether `npm test` passed.
- A build that prints 5 MB returns a preview plus a file path, not a flooded context.
- Long jobs run in the background: the agent calls `exec_background` for `pnpm build`, then `job_status` and `job_output`, and can `job_kill` it.
- If the sandbox is unavailable (for example on an unsupported kernel), the server refuses to start rather than silently running unconfined.
- The agent cannot edit the policy. There is no tool for it.
- `shell-mcp audit` prints a redacted log of every command it ran.

Good for: you want a shell you can hand to an unattended agent, and the shell is where you worry most.

## Variant C: B plus an fs server

You replace the reference fs server too, so one policy covers both tools natively.

```json
{ "mcpServers": {
  "fs":    { "command": "fs-mcp" },
  "shell": { "command": "shell-mcp" }
}}
```

Both servers take no arguments in the normal case. Optional overrides: `--policy <file>`, and for `fs-mcp` `--root <dir>[:ro]` to add a root without editing the policy file (for example `--root ~/docs:ro`).

What you notice in use:
- Read-only is a policy setting (`mode: ro` on a root), so you can give the agent a docs folder it cannot modify.
- The fs tools refuse `.env` and keys with a clear message the model understands, and `fs-mcp` has a `grep` tool, so the agent stops shelling out to `rg` just to search.
- Edits use exact-string replacement with a dry-run diff, and refuse files that changed on disk since the agent read them.
- Reads return line numbers and a "PARTIAL view, continue at line 400" notice, so the agent does not miscount lines in large files.
- Every tool carries read-only/destructive annotations, so hosts that support them can auto-approve reads and ask on writes.
- Symlinks that point outside the root are refused on both the fs and shell paths.

Good for: you want one coherent toolset and would use features the reference fs server lacks.

## Variant D: the same as C, one install

```bash
npm i -g workspace-tools        # installs sbx, shell-mcp, fs-mcp together
workspace-tools init            # optional: writes a starter workspace-policy.yaml
workspace-tools doctor          # checks macOS/Linux sandbox support, runs the proof suite
```

Host config is identical to C. What changes is adoption: one install, one version number, one place to look when something breaks. The cost is that you cannot take just the shell and leave the rest.

## Common to all variants

- **Zero-config path:** install, add the server entries from your variant, and you are confined by the built-in default. A policy file is something you add later.
- **Platforms:** macOS and Linux. Windows is not supported in the first release.
- **First run on Linux:** on Ubuntu 24.04 the sandbox may need an AppArmor setting. `doctor` tells you, so you do not discover it from a failed command.
- **Ceiling:** this is process-level isolation. For running untrusted code from strangers you still want a VM or container; this product does not replace that.
