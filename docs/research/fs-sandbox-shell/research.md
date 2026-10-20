# Filesystem, sandbox and shell tooling for agents: feature survey, demand mining, boundary design, build-vs-integrate

Measured 2026-10-11 (UTC). All star/download/issue counts below are labelled with that date unless stated. Researcher: research agent for the adhd repo, no code or repo edits made.

## 0. Method, source grades, caveats

Source grades used throughout:

- **A** = primary vendor doc or source file read in full or in the cited range during this session.
- **B** = GitHub/npm/PyPI API data pulled this session (counts, advisories, releases).
- **C** = prior memory episode (dated), reused and cited by uid, not re-verified unless stated.
- **U** = UNVERIFIED (inference, or not fetched).

Reproducible methods:

- Repo metrics: `gh api repos/<owner>/<repo> --jq '[.full_name,.stargazers_count,.open_issues_count,.pushed_at]'`. Note `open_issues_count` includes PRs.
- npm weekly downloads: `https://api.npmjs.org/downloads/point/last-week/<pkg>` (window 2026-10-04..2026-10-10). PyPI: `https://pypistats.org/api/packages/<pkg>/recent` (fetched 2026-10-11).
- Issue counts: `gh api -X GET search/issues -f q='repo:<R> is:issue state:<open|closed> <term>'` with `.total_count`. Top-requested: `q='<same> sort:reactions-+1-desc'`, reading `.reactions["+1"]`. Script: `/private/tmp/claude-502/-Users-nix-dev-node-adhd/f118b5b4-5fc4-458b-9f31-9ac647bb0cab/scratchpad/top.sh "<query>" <n>`.
- **Invalid-stat policy.** GitHub search ignores parenthesised OR groups (a first batch returned identical 96/166 totals for every term; discarded). Bare-word counts on openai/codex and google-gemini/cli are polluted by issue templates (for example `windows` 11,090 open on codex; `sandbox` 6,205 closed on gemini-cli whose top "sandbox" hits were IME and latency bugs). For those repos only `label:` and `in:title` counts are reported. Free-text per-keyword counts for server-filesystem (label-scoped) and sandbox-runtime are small repos and read as plausible, but still count title/body/comment matches, so treat them as indicative.
- Reactions are +1 counts on the issue body only.
- The repo `anthropic-experimental/sandbox-runtime` now resolves to `anthropics/sandbox-runtime`; `sst/opencode` resolves to `anomalyco/opencode`.

Memory reused (Phase 3), all grade C, measured 2026-10-06..08, cited where used:

- `01M47XA8VZDC5V67KZ44M0SBGK` fs-server landscape verdict (rust-mcp-filesystem, mcp-workspace, mark3labs, etc.).
- `01M47X7235SPHG4W4D07EJ627R` shell-server landscape re-filter (14 servers).
- `01M47X72D71RX2YVW8JS8139RW` "does any shell MCP ship a hard OS sandbox" (answer: five do, none a drop-in).
- `01M4E39RHKF4XFF7TE7BBFDDBD` tumf re-verification 2026-10-08.
- `01M46AWJ156GH74FY3K6G59M8M` adoption set and `01M46AWJ156GH74FY3K6G59M8K` sandboxing portability.
- `01M47W1Y1ZW49BJBXE116SV1AX` "no MCP fs server provides a hard OS sandbox".
- `01M47VYYH9E5QTE4JC9WYN29WN` mako10k, `01M47X73MXJMFKYH8PD4VWKV4F` agent-infra/sandbox.

New or changed since that memory: see section 7 (memory episodes written this run).

## 1. Landscape snapshot (2026-10-11)

| Item | Stars | Weekly downloads | Open issues (API, incl. PRs) | Last push | License | Grade |
|---|---|---|---|---|---|---|
| modelcontextprotocol/servers (monorepo; fs server is one package) | 91,149 | npm `@modelcontextprotocol/server-filesystem` 447,296 | 492 | 2026-10-11 | NOASSERTION | B |
| tumf/mcp-shell-server | 201 | PyPI 1,210/wk, 3,055/mo (npm `mcp-shell-server` 1.0.1 is an unrelated name collision) | 5 | 2026-10-06 | MIT | B |
| anthropics/sandbox-runtime (srt) | 5,509 | npm `@anthropic-ai/sandbox-runtime` 556,025 | 269 | 2026-10-11 | Apache-2.0 | B |
| anthropics/claude-code (tracker only; core closed source) | 150,227 | n/a | 14,697 | 2026-10-11 | none declared | B |
| openai/codex | 128,670 | n/a | 22,298 | 2026-10-11 | Apache-2.0 | B |
| google-gemini/gemini-cli | 107,286 | n/a | 761 | 2026-10-10 | Apache-2.0 | B |
| anomalyco/opencode | 212,731 | n/a | 3,988 | 2026-10-11 | MIT | B |
| wonderwhy-er/DesktopCommanderMCP | 10,001 | npm `@wonderwhy-er/desktop-commander` 202,332 | 300 | 2026-10-08 | MIT | B |
| rusiaaman/wcgw | 678 | PyPI 906 | 8 | 2026-09-12 | n/a | B |
| g0t4/mcp-server-commands | 235 | npm 618 | 8 | 2026-10-10 | n/a | B |
| mark3labs/mcp-filesystem-server | 695 | n/a | 27 | 2025-11-24 (stale) | n/a | B |
| rust-mcp-stack/rust-mcp-filesystem | 180 | n/a | 1 | 2026-08-29 | MIT | B |
| MarcusJellinghaus/mcp-workspace | 48 | n/a | 17 | 2026-09-30 | n/a | B |
| sonirico/mcp-shell (Landlock) | 108 | n/a | 0 | 2026-09-25 | GPL-3.0 | B |
| inercia/MCPShell | 71 | n/a | 6 | 2026-08-12 | n/a | B |
| @mako10k/mcp-shell-server | 6 | npm 125 | 2 | 2026-09-01 | MIT | B |
| kaplanelad/shellfirm (advisor, does not execute) | 936 | n/a | 3 | 2026-05-15 | n/a | B |
| agent-infra/sandbox (AIO, Docker) | 6,140 | n/a | 72 | 2026-09-14 | Apache-2.0 | B |
| e2b-dev/E2B (SDK) / e2b-dev/infra (runtime) | 14,279 / 1,709 | npm `e2b` 2,058,297; PyPI `e2b` 1,627,305 | 96 / n/a | 2026-10-09 / 2026-10-11 | Apache-2.0 | B |
| daytonaio/daytona | 71,566 | npm `@daytonaio/sdk` 703,309; PyPI `daytona` 2,041,155 | 458 | 2026-07-24 | n/a | B |
| superradcompany/microsandbox (libkrun-style local microVMs) | 8,650 | n/a | 96 | 2026-10-11 | n/a | B |
| firecracker-microvm/firecracker | 37,295 | n/a | 95 | 2026-10-09 | Apache-2.0 | B |
| google/gvisor | 19,638 | n/a | 947 | 2026-10-11 | Apache-2.0 | B |
| containers/bubblewrap | 9,010 | n/a | 204 | 2026-09-25 | NOASSERTION | B |
| cloudflare/sandbox-sdk / vercel/sandbox | 1,148 / 210 | n/a | 47 / 33 | 2026-10-08 / 2026-10-11 | n/a | B |

Ranking among genuine shell/exec MCP servers by stars: DesktopCommander (10,001) >> wcgw (678) > g0t4 (235) > tumf (201) > sonirico (108) > fwerkor/local-shell-mcp (89, memory) > inercia (71). By weekly downloads: DesktopCommander (202k npm) >> tumf (1.2k PyPI) ≈ wcgw (0.9k PyPI) > g0t4 (618 npm). The adopted tumf server is a long-tail choice by popularity; it is chosen on policy fit (grade C `01M47X7235SPHG4W4D07EJ627R`), not adoption.

Pins in this repo vs upstream (grade A/B):

- `@modelcontextprotocol/server-filesystem` is pinned `2026.7.10` (`/Users/nix/dev/node/adhd/packages/agent/agent-core-native-tooling/package.json:17`); npm `latest` is `1.0.0`, published 2026-10-11 (npm registry `time`). The 1.0.0 changelog says it is "the last release of the legacy-era server, on the 1.x MCP SDK" (https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/CHANGELOG.md:3-4).
- `@anthropic-ai/sandbox-runtime` is `^0.0.78` (`package.json:16`). Caret on a `0.0.x` version admits only that exact patch, so 0.0.79 (published 2026-10-07, npm `time.modified`) is excluded. The pin is effectively exact.
- `mcp-shell-server==1.1.12` (`catalog.ts:113`) is the latest release (v1.1.12, 2026-09-19) and, per the advisory table (section 3.3), the first version patched against every one of tumf's 14 published advisories.

## 2. Part A: Best features across all of them

Each row: feature, where it lives (source reference), use case.

### A.1 Filesystem

| # | Feature | Source | Use case |
|---|---|---|---|
| F1 | MCP Roots: allowed directories come from CLI args or are replaced dynamically by the client's roots; a roots update with no valid root revokes all access | https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md (lines 16-67); CHANGELOG 1.0.0 (#5094 "roots/list_changed update that leaves no valid root") | Host-driven workspace scope that follows the dispatching cwd without respawning the server. Maps directly to ADR-0008 D4 (task-time resolution). |
| F2 | MCP ToolAnnotations on every tool (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint:false`) | same README lines 191-219 | A host gate can auto-allow read-only tools and force `ask` on destructive ones without parsing arguments. Codex does exactly this for MCP tools (https://developers.openai.com/codex/agent-approvals-security via learn.chatgpt.com/docs/agent-approvals-security: "Destructive app/MCP tool calls require approval when the tool advertises a destructive annotation. A read annotation takes priority."). |
| F3 | Symlink containment on the tool path: `realpath` of every ancestor and the target, `wx` exclusive create, `lstat` plus `O_NOFOLLOW` open for overwrite, `move_file` refuses to overwrite | `src/filesystem/lib.ts` on main: lines 151-188, 242-249, 299-301, 320-346, 371-379 (https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/lib.ts) | TOCTOU-resistant writes. Two earlier high-severity advisories (path-prefix collision GHSA-hc55-p739-j48w and symlink bypass GHSA-q66q-fx2p-7w4m, both fixed in 2025.7.01) show why it matters. |
| F4 | `edit_file`: multi-edit, `dryRun` git-style diff, whitespace-normalised matching, indentation and CRLF preservation | fs README lines 100-125; CHANGELOG #5011 | Safe partial edits with a preview. |
| F5 | `read_text_file` with `head`/`tail`, `read_media_file` (base64 image/audio/resource) | fs README lines 73-95 | Bounded reads; images for vision models. |
| F6 | Claude Code Edit: exact string replace, must appear exactly once or `replace_all`, read-before-edit, edits against changed-on-disk files only if the match is still unambiguous, refuses non-UTF-8 | https://code.claude.com/docs/en/tools-reference ("Edit tool behavior", lines 248-270 of the fetched page) | Prevents blind or ambiguous overwrites; no fuzzy matching means no silent mis-edits. |
| F7 | Claude Code Read: absolute paths, line-numbered output, 25,000-token cap per call, whole-file refusal over 256 KB, `PARTIAL view` notice, `offset`/`limit`, PDFs by page ranges (max 20 pages), notebooks, images downscaled | same page, "Read tool behavior" lines 500-521 | Bounded context cost with explicit continuation hints to the model. |
| F8 | Symlink rule asymmetry: allow rules need both the requested path and its resolved target to match; deny rules apply if either matches | https://code.claude.com/docs/en/permissions "Symlinks" (lines 451-479) | Fail-closed on symlink indirection. |
| F9 | gitignore-style Read/Edit rules with `!` negation carving exceptions | same page line 442 | Compact deny lists (`Read(*.env)`, `Read(!sample.env)`). |
| F10 | Default-deny of dotenv reads (`*.env`, `*.env.*` denied, `*.env.example` allowed) in the permission defaults | https://opencode.ai/docs/permissions/ ("Defaults") | Secret-file protection out of the box. Codex's #2847 "A way to exclude sensitive files" has 470 thumbs-up (closed), showing demand. |
| F11 | Protected subpaths inside writable roots: `.git` (dir or `gitdir:` target), `.codex`, `.agents` read-only | https://learn.chatgpt.com/docs/agent-approvals-security; `codex-rs/linux-sandbox/README.md` | Stops an edit tool from planting hooks or config that run later with more authority. srt equivalent: mandatory deny list (`.bashrc`, `.gitconfig`, `.git/hooks/`, `.mcp.json`, `.claude/commands/`) at https://github.com/anthropics/sandbox-runtime README lines 914-935. |
| F12 | Read-only-by-default server and per-root read-only | rust-mcp-filesystem (180 stars, whole-server RO), mcp-workspace (48 stars, per-root RO) | Memory only: `01M47XA8VZDC5V67KZ44M0SBGK` (grade C, 2026-10-06, not re-fetched). Only fs servers with RO below a Docker mount. |
| F13 | Document and data reads (PDF, Excel, URL), fuzzy `edit_block` fallback with similarity report, per-tool line limits | https://github.com/wonderwhy-er/DesktopCommanderMCP README lines 584-596, 642-650 | Broad-format agents. Security caveat in C. |
| F14 | Mounts with explicit mode `from:to:opts`, default `ro` | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md lines 319-336 (`SANDBOX_MOUNTS`) | Read-only extra roots as the default posture. |

### A.2 Sandbox

| # | Feature | Source | Use case |
|---|---|---|---|
| S1 | Dual isolation with asymmetric defaults: reads allowed-by-default with deny-then-allow; writes denied-by-default; network denied-by-default via proxies (network namespace removed on Linux) | srt README lines 113-135 (https://github.com/anthropics/sandbox-runtime) | One config covers fs and egress for an arbitrary process tree. |
| S2 | Resolved-address guard: allowed hostnames are resolved once and dropped if they resolve to loopback, link-local, multicast, or cloud-metadata endpoints (`100.100.100.200`, `168.63.129.16`, `fd00:ec2::/32` ...); `deniedResolvedAddresses` extends it | srt README "Network Configuration" (lines ~455-470) | Blocks DNS-rebinding style SSRF via allowed names. Issue #88 (DNS exfil, 15 thumbs-up, closed) is the motivating bug. |
| S3 | Credential handling: `credentials.envVars/files` with `mode: deny` (withhold) or `mask` (sentinel inside the sandbox, proxy substitutes the real value on egress to allowed hosts) | srt README "Other Configuration" `credentials` | Agents can call authenticated APIs without ever holding the secret. |
| S4 | TLS termination plus `filterRequest` callback, `requireHostMatch`, `refuseOpaqueTunnels`, response header stripping; `srt proxy` with an external decider | srt README lines 257-260 and network section | Content-aware egress policy; closes the domain-fronting gap Claude Code documents as a limitation (https://code.claude.com/docs/en/sandboxing "Security limitations"). |
| S5 | Mandatory deny paths and Linux "pinned directories" so a protected path's ancestors cannot be renamed away | srt README lines 914-962 | Defence against config/hook tampering and rename escapes. |
| S6 | Per-run settings file `srt -s <path>`; library embedding; violation store/monitor | srt README lines 160-260, 992-1010; used locally at `catalog.ts:200-230` and `srt-policy.ts:16-22` | Per-spawn policy without mutating a shared global file. |
| S7 | Claude Code: auto-allow vs regular-permission sandbox modes; unsandboxed retry via `dangerouslyDisableSandbox` that is itself permission-gated (`ask` rule `Bash(dangerouslyDisableSandbox:true)`); strict mode `allowUnsandboxedCommands:false`; managed settings make the sandbox admin-required | https://code.claude.com/docs/en/sandboxing "Sandbox modes" (lines 176-252 of the fetched page) | Escape hatch with an audit point instead of a silent bypass. |
| S8 | Claude Code `permissions.blockReadsOutsideWorkingDirectories` | sandboxing page lines 527-535 | Closes the "default read everywhere" gap srt leaves open (srt #2, 14 thumbs-up, open). |
| S9 | Permission rules and sandbox settings merge into one sandbox config (`Edit` allow equals `sandbox.filesystem.allowWrite`; `Read` deny feeds `denyRead`; `WebFetch(domain:)` and `allowedDomains` merge) | sandboxing page "Permission rules" table (lines 643-668) | One policy intent, one enforcement set: the strongest boundary design found (see C). |
| S10 | Codex Linux: bwrap default, `--ro-bind / /`, writable roots layered, protected subpaths re-applied read-only, path-specificity ordering of nested allow/deny, unreadable glob entries expanded via `rg --files` and masked, `glob_scan_max_depth`, symlink-in-path and missing protected components blocked by mounting `/dev/null`, seccomp blocks `io_uring` and `AF_VSOCK`, `--unshare-net` plus TCP-UDS-TCP bridge to a managed proxy | https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md (lines 1-110) | Most detailed open implementation of fs carve-outs; legacy Landlock explicitly rejected because it cannot isolate app-server Unix sockets (same README). |
| S11 | Codex permission profiles (`[permissions.<name>]`, `extends = ":workspace"`, `[...network]`, `default_permissions`), network off by default, domain allowlist with deny-wins, `allow_local_binding` default false | https://learn.chatgpt.com/docs/agent-approvals-security | Named, inheritable profiles. |
| S12 | Gemini: six Seatbelt profiles (`permissive-open` .. `strict-proxied`), Docker/Podman, gVisor `runsc`, LXC, Windows low-integrity (`icacls`), tool-level sandboxing (`security.toolSandboxing`) and "Sandbox Expansion Request" (approve extra paths/network for one run) | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md lines 86-336 | Widest backend menu; expansion request turns a denial into a scoped, user-approved grant. |
| S13 | Firecracker microVM per sandbox with own cgroup, netns, nftables egress firewall and SNI/Host domain lists; snapshot resume | https://github.com/e2b-dev/infra README (E2B runtime) | Hardware-boundary isolation for untrusted code; remote/cloud. |
| S14 | Daytona: OCI-compatible sandboxes, "under 90ms" start (vendor claim); microsandbox: local microVMs; gVisor `runsc`: user-space kernel, OCI runtime | READMEs of daytonaio/daytona, superradcompany/microsandbox, google/gvisor | Stronger-than-namespace isolation tiers. Performance numbers are vendor claims, U. |
| S15 | Landlock: unprivileged self-restriction of fs access, TCP port rules since ABI v4 | https://raw.githubusercontent.com/torvalds/linux/master/Documentation/userspace-api/landlock.rst | No-root Linux primitive; srt #41 (11 thumbs-up, open) and sonirico/mcp-shell use it. |

### A.3 Shell

| # | Feature | Source | Use case |
|---|---|---|---|
| H1 | Argv-only execution (never a shell string), `ALLOW_COMMANDS` names plus `ALLOW_PATTERNS` regex fullmatch on names, built-in argument hardening for known exec vectors, contained `<` `>` `>>` redirection, minimal child env, timeout and output byte caps, structured audit log | https://github.com/tumf/mcp-shell-server README lines 8-37; local use `catalog.ts:115-144` | Eliminates metacharacter injection class; cheap audit. |
| H2 | Honest contract: README states it is "not a sandbox", lists what it does and does not control, and lists the six properties an external boundary must provide (least-privilege identity, fs scope, egress deny, credential exclusion, descendant containment, resource limits) | tumf README lines 28-66 | Exactly the division of labour in C. |
| H3 | Claude Code Bash permission engine: whole-command text match with `*`, compound commands split per subcommand, fixed wrapper strip list (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`), deny then ask then allow, first match wins; docs state rules are "not a security boundary around the program" | https://code.claude.com/docs/en/permissions "Bash" (lines 217-262, 62-64) | Best-in-class command-text gating, and the vendor itself says it is bypassable in other forms. |
| H4 | Tool runtime: 2-minute default timeout, 10-minute cap, output inline up to ~30,000 chars then spilled to a session file with a 2,000-char preview, `run_in_background`, cwd persists but env does not, Linux memory cgroup cap `CLAUDE_CODE_TOOL_MEMORY_LIMIT` | https://code.claude.com/docs/en/tools-reference lines 139-247 | Output spill and resource caps are shell-server concerns, not sandbox concerns. |
| H5 | Codex execpolicy: Starlark `prefix_rule(pattern, decision=allow|prompt|forbidden, justification, match, not_match)` with load-time example tests, and `host_executable(name, paths)` to constrain which absolute paths a basename may resolve to | https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md lines 1-60 | Testable argv-prefix policy with justification strings returned to the model. |
| H6 | Gemini policy engine: TOML rules by `toolName`, `mcpName`, `commandPrefix`, `commandRegex`, `argsPattern`, `annotations`, `subagent`, `interactive`, `modes`; tiers Default < Extension < Workspace < User < Admin; `deny_message` returned to the model. The Workspace tier is documented as non-functional (#18186) | https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md lines 125-167, 284-344 | Rich rule schema and admin override tier. |
| H7 | opencode permission map: `bash` matched on parsed command, last matching rule wins, per-agent overrides, `external_directory` and `doom_loop` default `ask`, `--auto` approves asks but keeps denies | https://opencode.ai/docs/permissions/ | The model ADR-0008 D5 copied (last-match-wins with terminal deny). |
| H8 | Interactive processes (`start_process` with ready-detection, REPLs, SSH sessions) | DesktopCommanderMCP README lines 577, 610 | Long-lived sessions; this is the main thing tumf lacks (single `shell_execute`, `catalog.ts:121`). |
| H9 | Security modes and elicitation (ask) in-server, Bubblewrap `restrictive` mode | @mako10k/mcp-shell-server, memory `01M47VYYH9E5QTE4JC9WYN29WN` (grade C): default `permissive` runs unrestricted | Only shell server with an in-server HITL primitive. Blocked because of default and 6 stars. |
| H10 | Command-risk advisor (does not execute): explain and suggest alternatives | kaplanelad/shellfirm 936 stars (memory `01M47X7235SPHG4W4D07EJ627R`) | Companion guard, not a shell server. |

## 3. Part B: Most requested items and complaints (with statistics)

Queries are in section 0; every count is 2026-10-11 and GitHub-search based. "Thumbs-up" = `reactions["+1"]` on the issue.

### 3.1 modelcontextprotocol/servers, filesystem server (`label:server-filesystem`)

- Label total 88 issues: 44 open, 44 closed (query `repo:modelcontextprotocol/servers is:issue label:server-filesystem state:<s>`).
- Keyword counts inside the label (open/closed): read-only 12/8, write 11/12, Windows 14/21, image 9/12, docker 8/2, edit_file 4/7, symlink 2/5, permission 8/3, roots 3/9, exclude 3/0, ignore 3/3, performance 2/0, timeout 2/1.
- Most-reacted open items:
  - #533 "Read Image File for Filesystem server" 23 thumbs-up, open (the README now documents `read_media_file`, so the issue is stale or incomplete) https://github.com/modelcontextprotocol/servers/issues/533
  - #470 Windows path rejected on casing mismatch 13 thumbs-up https://github.com/modelcontextprotocol/servers/issues/470
  - #1613 `workspaceFolder` unresolved in VS Code 10 https://github.com/modelcontextprotocol/servers/issues/1613
  - #3051 stopped working with OpenAI Agent SDK 8 (23 comments) https://github.com/modelcontextprotocol/servers/issues/3051
  - #896 confusing `search_files` description 6; #1879 env-var configuration 5; #2219 ignore dot directories 3; #2308 exclusion pattern config 3; #632 "Configurable write permissions" 1; #3457 "follow symlinks option" 0; #4208 excludes are lexical, not symlink-aware 0; #5074 README should say it is a reference implementation and point to alternatives 0.
- Themes (ranked by evidence): (1) Windows/path normalisation (35 label-scoped mentions), (2) read-only or write permission control (12 open read-only mentions plus #632), (3) exclusion/ignore patterns (#2219, #2308, #4208), (4) media/binary reads (#533), (5) client compatibility (#3051, #1613).
- Security record of the monorepo (API `security-advisories`): 6 published, 2 high (GHSA-hc55-p739-j48w path-prefix collision, GHSA-q66q-fx2p-7w4m symlink handling, both patched 2025.7.01) and 4 medium (git server). Issue #4902 "Triage the security advisory backlog (61 in triage)" is open.
- The headline NVM/npx failure #64 (147 thumbs-up, closed) is a launcher problem; the local catalog already avoids it by running `node <resolved bin>` (`catalog.ts:37-100`).

### 3.2 anthropics/sandbox-runtime (srt)

- 152 issues: 114 open, 38 closed. Keyword counts open/closed: linux 48/18, macOS 47/17, bwrap 27/11, proxy 25/10, env 21/9, git 20/7, allowRead 18/9, windows 18/3, docker 15/3, seccomp 14/1, unix socket 12/1, credential 7/0, symlink 9/2, glob 7/3.
- Top by thumbs-up:
  - #139 "srt leaks dotfiles and directories while running commands and when sigkilled" 77, open, 34 comments https://github.com/anthropics/sandbox-runtime/issues/139 (sibling #85, 31, closed)
  - #165 `allowLocalBinding` not implemented on Linux (bwrap) 21, open
  - #105 Windows support 16, open (README now documents Windows alpha, lines 725-790, so partly delivered)
  - #88 data exfiltration via DNS when `allowLocalBinding` 15, closed; #225 `allowLocalBinding` also lifts outbound TCP 12, closed
  - #2 "Is there a way to not default-allow read access to the whole system?" 14, open; #10 "Cannot express workspace-only filesystem access" 11, closed
  - #41 Landlock support 11, open; #74 bwrap fails on Ubuntu 24.04+ (AppArmor userns) 11, open
  - #159 hardcoded `.idea` deny blocks git operations 8; #253 disable network isolation but keep fs sandbox 8
- Themes: (1) residue/dotfile creation and leaks, (2) default-read-everywhere (#2, #10), (3) Linux parity gaps (bwrap, AppArmor, local binding), (4) Windows, (5) mandatory-deny list too rigid (#159).
- Only 1 published advisory (low, network sandbox escape, fixed 0.0.16).

### 3.3 tumf/mcp-shell-server

- 11 issues total (all listed via `gh issue list -R tumf/mcp-shell-server --state all`), 0 reactions anywhere. Open: #59 audit anchoring proposal, #57 and #54 CVE-ID requests. Closed notable: #51 "supported way to override/exempt entries in DANGEROUS_COMMANDS", #47 startup crash with mcp SDK 2.0.0, #41 harden argument validation, #32 allowlist bypass report, #11 default directory to CWD.
- **Security advisories: 14 published 2026-07-18..2026-09-19 (11 high, 3 medium)** via `gh api repos/tumf/mcp-shell-server/security-advisories`. Examples: GHSA-7v25-vcp6-4hcr git global options bypass (patched 1.1.12), GHSA-8wm7-jvxq-2r3m gawk program-source RCE (1.1.11), GHSA-74g6-ch7r-v7jr sort argv options (1.1.9), GHSA-pp9g-g8q6-vrhj incomplete exec-capable denylist (1.1.6), GHSA-88qq-fvcm-92qq sed `e` and find `-fprintf` (1.1.3), GHSA-56qh-7rgp-wfgr git `-c` keys (1.1.2). Every one has a patched version at or below 1.1.12, so the local pin `==1.1.12` is the first fully patched release. The cadence (a new high-severity bypass roughly every 1-2 weeks through mid-September) predicts more; the pin is current, not safe-forever.
- Local consequence: `DEFAULT_SHELL_ALLOW_COMMANDS` includes `awk`, `git`, `sort`, `tee`, `chmod` (`catalog.ts:161-168`), the very names behind GHSA-8wm7, 7v25 and 74g6. These are exactly the programs the argument-hardening denylist keeps chasing.

### 3.4 wonderwhy-er/DesktopCommanderMCP

- 341 issues: 209 open, 132 closed. Free-text keyword counts are template-polluted, so only the top items are reported: #10 WSL configuration 13 thumbs-up (open), #266 tool descriptions too long 5 (open), #180 "Spyware Injection and Context Pollution" (telemetry) 4 (open, 10 comments).
- Its own README warns: directory restrictions and command blocking "can be bypassed through various methods including symlinks, command substitution, and absolute paths" (line 830), "`allowedDirectories` setting currently only restricts filesystem operations, not terminal commands" (line 834), and that the model may rewrite its own `allowedDirectories` config (line 832). No published GitHub advisories via the API. Verdict stays BLOCKED (memory `01M46AWJ156GH74FY3K6G59M8M`).

### 3.5 openai/codex (label and title scoped)

- `label:sandbox`: 2,615 issues (1,920 open, 695 closed). `in:title sandbox`: 1,222 (869 open, 353 closed).
- Top `label:sandbox` by thumbs-up: #2847 "A way to exclude sensitive files" 470 (closed, 92 comments); #3085 "specific commands that don't need permission" 107 (closed); #16088 empty `.codex` file left behind 88; #3141 "Allow GPU access inside sandbox" 62 (open); #1260 "auto-approved commands configurable via execpolicy" 59 (closed). `in:title sandbox`: #47345 Linux sandbox fails with mountinfo path not absolute 37; #15283 bubblewrap 0.4.0 `--argv0` 32; #51601 Windows sharing violation 31 (open, 122 comments).
- Themes: sensitive-file exclusion, per-command allow lists, GPU/device access, platform breakage (bwrap versions, Windows, WSL1), residue files.

### 3.6 google-gemini/gemini-cli (title scoped only)

- `in:title sandbox`: 138 (14 open, 124 closed). Top: #8682 keystroke loss when sandboxed on macOS 10; #3404 docker sandbox build fails 7; #26964 sandbox broken in 0.42.0 6. Policy engine: workspace-tier policies non-functional (#18186, per policy-engine.md line 127). Themes: macOS TTY/perf, docker build, docs.

### 3.7 anomalyco/opencode

- `in:title sandbox`: 31 (5 open, 26 closed). #2242 "Is there a way to sandbox the agent?" 78 thumbs-up, open, 96 comments; #9132 official Docker sandbox template 42; #21733 filesystem sandbox for bash/subprocesses separate from permission prompts 3 (closed); #48411 better execution permissions and sandboxing 3 (open). opencode has no OS sandbox (docs make no sandbox statement; memory `01M46AWJ156GH74FY3K6G59M8K`).
- `in:title permission`: 641 (101 open, 540 closed). #8463 YOLO flag 94; #239 TUI permissions 42; #37564 LLM classifier auto-approval 40; #13715 "Permission asks from nested subagent sessions silently hang" 32 (closed); #20066 persist "allow always" across sessions 30.
- Direct relevance: #13715 is the failure mode ADR-0008 D6 prevents with the "unanswered ask denies" floor.

### 3.8 anthropics/claude-code (tracker)

- `in:title sandbox`: 902 (195 open, 707 closed). Top: #28018 allow outbound localhost 80 (open); #23416 macOS sandbox blocks Security.framework TLS, breaking Go binaries 69 (open); #29533 same, 33 (closed); #70684 SOCKS5 proxy auth breaks BSD nc 34; #78419 sandbox stubs break `git add .` 34.
- `in:title permission`: 2,890 (394 open, 2,496 closed). #28240 permission prompt fires on `cd` instead of the real command in compound commands 209 (open); #16561 parse compound Bash commands and match each part 176 (closed, shipped: see permissions doc "Compound commands"); #30519 "Permissions matching is fundamentally broken, 30+ open issues" 79; #18950 subagents do not inherit user-level permissions 72.
- Themes: command-text matching is the dominant pain (the argument for ADR-0008 D5's stance that the harness should not own command parsing); localhost/TLS egress through the proxy; subagent permission inheritance.

### 3.9 Cross-project ranked themes (evidence summary)

1. Command-text permission matching is fragile (Claude Code #28240 209, #16561 176, #30519 79; tumf 14 advisories; execpolicy's `match`/`not_match` tests exist because of it).
2. Sensitive-file exclusion (Codex #2847 470; opencode `.env` default deny; srt #2 14).
3. "Is there a real sandbox?" (opencode #2242 78 and #9132 42; Gemini six backends; DC README).
4. Egress through a proxy breaks real tools (Claude Code #23416 69, #28018 80, #70684 34; srt #165 21, #225 12).
5. Cross-platform parity (srt #105 Windows 16, #74 Ubuntu AppArmor 11, Codex #47345/#15283/#51601).
6. Non-interactive asks must resolve (opencode #13715 32).
7. Windows path handling in fs servers (servers #470 13; label-scoped Windows 14 open/21 closed).

## 4. Part C: The boundary

### 4.1 Proposed split

| Dimension | Owner (defines it) | Enforcer (makes it true) | Notes / overlap hazard |
|---|---|---|---|
| Filesystem read scope | One workspace policy record | **Sandbox** (kernel): `denyRead` broad region + `allowRead` roots | fs server roots are a UX/second-line check only. If only the fs server scopes reads, the shell escapes it (4.2 O1). |
| Filesystem write scope | same record | **Sandbox** `allowWrite`/`denyWrite`; fs server mirrors it as its roots | Must be derived from the same list as fs server args (`resolveFsRoots` exported for exactly this, `resolver.ts:238`). |
| Protected paths (.git hooks, rc files, MCP config) | Sandbox | **Sandbox** mandatory deny (srt README 914) | fs server cannot see shell-side writes; only OS layer covers both. |
| Symlink / traversal containment | fs server (tool path) and sandbox (OS path) | Both; sandbox is authoritative | `isWithin` in `resolver.ts:216` is lexical only and says so (lines 203-215). |
| Read-only mode | Policy | Sandbox (no `allowWrite`) plus fs tool filtering (`allowedTools`/`disallowedTools`, `resolver.ts:275-276`) | Tool filtering alone does not stop `shell`. |
| Network egress | Policy | **Sandbox** proxy/namespace | Shell server must pass proxy env to children (`MCP_SHELL_CHILD_ENV_ALLOWLIST`, `catalog.ts:131-137`). fs server needs none (`srt-policy.ts:132-136`). |
| Command allowlist (names/argv shapes) | Shell server config | **Shell server** | Convenience and hygiene, not confinement: tumf README lines 40-50 say so; 14 advisories confirm. |
| Per-command ask/deny, tool-name gating, HITL | Host (agent-mcp) | **Host gate** | Thin tool-name gate only (ADR-0008 D5, lines 103-132 of the ADR). |
| Environment / secrets | Policy | Shell server child-env allowlist (what it passes) plus sandbox credential `deny`/`mask` (what exists to read) | Two layers needed; neither alone covers inherited files like `~/.npmrc`. |
| cwd | Host resolves at task time | Shell server `cwd` (spawn) plus sandbox allow (reach) | A cwd outside `allowWrite` fails inside the sandbox (`resolver.ts:288-291` comment). |
| Timeouts / output caps | Shell server | Shell server | Not a sandbox concern. |
| CPU / memory / pids / wall-clock | Sandbox or container | cgroup/rlimit layer | Neither srt nor tumf enforces these; tumf README line 63 delegates them. Claude Code adds a cgroup memory cap outside the sandbox (tools-reference lines 223-247). |
| Descendant processes | Sandbox | Sandbox (inherits restrictions) | Argv allowlists cannot see grandchildren (tumf README lines 42-48). |
| Escape hatch (run unsandboxed) | Host policy | Host gate | Claude Code makes it a gated parameter and offers a strict mode that removes it (sandboxing page, lines 176-252 region). agent-mcp has none: good. |

Rule of thumb: whichever layer can be bypassed by a child process is advisory. Only the sandbox sees every descendant; only the shell server sees argv; only the fs server sees tool semantics; only the host sees tool names and the human.

### 4.2 Overlaps that cause bugs in this repo (found by reading; grade A for the code, U for behaviour because not executed this run)

- **O1. Shell reads outside the fs allowlist.** The fs server is scoped to `resolveFsRoots` (`resolver.ts:238-254`; roots become argv at line 272). The shell is wrapped by srt, whose read model is "allowed everywhere by default" (srt README lines 113-120). The local policy only unions five credential paths into `denyRead` (`srt-policy.ts:150-159`, merge at line 847), so `cat /some/other/repo/.env` through the shell is not blocked by anything in the stack, even though the fs tool would refuse it. Claude Code closes this with `blockReadsOutsideWorkingDirectories` (sandboxing page lines 527-535); srt can already express it (`denyRead:["/Users"], allowRead:["."]`, README lines 579-583). The local policy does not emit it. Open demand: srt #2 (14 thumbs-up), #10 (11).
- **O2. Allowlist advertises tools the egress policy starves.** `DEFAULT_SHELL_ALLOW_COMMANDS` contains `npm`, `pnpm`, `npx`, `uv` (`catalog.ts:167`), while `DEFAULT_SRT_ALLOWED_DOMAINS` is PyPI only (`srt-policy.ts:137-141`) and the comment says the npm registry is deliberately absent (lines 132-136). Inference (U): uncached fetches by these commands fail inside the sandbox unless the operator adds domains via `allowedDomains` (`srt-policy.ts:113-114`). Not executed.
- **O3. The argv allowlist contains code-exec launchers.** `npx`, `make`, `npm`, `pnpm`, `nx`, `tsc`, `uv`, `git`, `awk` (`catalog.ts:161-168`) each run arbitrary code or config by design. tumf says allowed programs inherit the server's authority (README line 42), and its advisories (3.3) are exactly bypasses through such programs. Therefore the srt policy, not the allowlist, is the control that matters (this matches ADR-0008 D5 "the OS sandbox is the boundary", ADR lines 126-132).
- **O4. Same intent expressed in three configs.** Roots (`resolver.ts:238`), srt `allowWrite/allowRead` (`srt-policy.ts:169-192` plus per-run provisioning), and the shell allowlist (`catalog.ts:161`) are separate inputs. The code already moves toward single derivation (`resolveFsRoots` exported so the per-run srt policy is "provisioned from the SAME list", `resolver.ts:234-236`), but read scope (O1) and egress domains (O2) are not derived from policy.

### 4.3 Real designs that got it right or wrong

| Design | Verdict | Evidence |
|---|---|---|
| Claude Code permissions + sandbox | **Right** on merging intent: permission rules and sandbox settings merge into one sandbox config (`Edit` allow = `allowWrite`). **Wrong/limited** on coverage: Read/Edit/Write tools, local MCP servers and hooks run outside the sandbox, "a `denyRead` entry doesn't stop the Read tool" | https://code.claude.com/docs/en/sandboxing "What runs outside the sandbox" (lines 38-52 of fetched page) and "Permission rules" table |
| Claude Code Bash permission engine | **Right** to split compound commands; **Wrong** to rely on text matching as security, which the docs concede; 30+ matching bugs (#30519) | permissions page lines 217-262; issue #30519 |
| Codex | **Right**: one policy (`SandboxPolicy`/profiles) drives bwrap/seccomp/Seatbelt for commands; protected subpaths; MCP calls gated separately by annotations. **Gap**: command network proxy "does not filter MCP server connections" | linux-sandbox README; learn.chatgpt.com/docs/agent-approvals-security |
| Gemini CLI | **Right**: backend menu and tool-level sandboxing, sandbox expansion requests. **Wrong**: Workspace policy tier non-functional (#18186) so repo-level policy silently does nothing | sandbox.md; policy-engine.md lines 127-131 |
| opencode | **Right** permission map semantics, `external_directory` ask. **Gap**: no OS sandbox, which is the top sandbox demand (#2242, 78) | opencode.ai/docs/permissions; tracker |
| DesktopCommander | **Wrong**: `allowedDirectories` limits only fs tools not the terminal, and the model can edit its own policy | README lines 830-834 |
| tumf/mcp-shell-server | **Right**: states what it does not control and what the external boundary must supply | README lines 28-66 |
| srt wrapping MCP servers | **Right**: documented use case "Sandboxing MCP Servers" with `srt` as the server command | srt README lines 50-60 |
| agent-mcp today | Right on layering (sandbox wraps both servers, thin gate); gaps O1-O4 above | ADR-0008 lines 103-132; `resolver.ts:146-157` |

## 5. Part D: Exhaustive feature tables

Column key: **Base?** = base requirement for a production agent toolset (yes/no). "Best ref" = best code/doc reference found. Items marked (C) come from prior memory; (U) unverified.

### D.1 Filesystem

| Feature | Base? | Great feature + why | Unsolved problem | Best code reference |
|---|---|---|---|---|
| Path allowlist / roots | yes | Roots protocol replaces allowlist live; revocation on empty roots; deterministic cwd scoping | Windows casing/UNC normalisation (servers #470, 13 thumbs-up, open) | modelcontextprotocol/servers `src/filesystem/README.md:16-67`; local `resolver.ts:238-254` |
| Read file (text, line ranges) | yes | head/tail; Claude Code 25k-token cap with PARTIAL notice and explicit continuation | No standard continuation protocol across servers | fs README `read_text_file`; code.claude.com tools-reference Read |
| Read media / binary | yes | `read_media_file` returns typed image/audio/resource content | Issue #533 (23 thumbs-up) still open though feature exists; PDFs need external tools in Claude Code | fs README `read_media_file` |
| Write / overwrite | yes | In-place overwrite keeping inode, perms and hard links; `wx` create; `O_NOFOLLOW` | Not crash-atomic (README line ~105 states it) | fs `lib.ts:299-346` |
| Exact-string edit | yes | Uniqueness + read-before-edit + stale-file safety | Whitespace misses; fuzzy fallback (DC) trades safety for hit rate | code.claude.com tools-reference Edit; DC README 642-650 |
| Edit dry-run diff | no | `dryRun` returns git-style diff | Not exposed by Claude Code Edit | fs README `edit_file` |
| Move/rename | yes | `move_file` refuses to overwrite | Cross-root moves and rename races | fs `lib.ts:371-379` |
| Create dir / list / tree | yes | `list_directory_with_sizes`, `directory_tree` with exclude globs | `.gitignore` awareness absent (servers #2219, #2308) | fs README |
| Search by name/glob | yes | glob `search_files` with exclude patterns | Excludes are lexical, not symlink-aware (servers #4208) | fs README `search_files` |
| Content grep | yes | Present in rust-mcp-filesystem, mark3labs (C) | The reference server has none (agents must use shell `rg`, widening the shell surface) | memory `01M47XA8VZDC5V67KZ44M0SBGK` (C) |
| Symlink containment | yes | realpath of ancestors and target | Reference server lexical excludes; option to follow symlinks requested (servers #3457) | fs `lib.ts:151-188`; Claude Code permissions "Symlinks" 451-479 |
| Read-only mode | yes | OS-level via sandbox (no `allowWrite`); tool-level via annotations | Reference server has no RO flag; per-root RO only in mcp-workspace (C); servers #632 (1 thumbs-up) | srt README 120-125; memory (C) |
| Sensitive-file exclusion | yes | Default `.env` deny (opencode); gitignore-pattern Read deny with negation (Claude Code) | Tools outside the sandbox bypass `denyRead` (Claude Code doc); Codex #2847 470 thumbs-up | permissions page 347-352, 442; opencode permissions |
| Protected paths in writable roots | yes | `.git`, `.codex`, `.agents`, rc files, hooks, `.mcp.json` | Hardcoded lists block legitimate ops (srt #159 `.idea`) | srt README 914-935; Codex linux-sandbox README |
| Tool annotations (read/destructive hints) | yes | Lets the host gate by hint | Honour depends on client; hints are advisory | fs README 191-219 |
| Per-path ask/deny | no | Claude Code `Read(path)`/`Edit(path)` rules | Not available in any fs MCP server (C `01M47W1Y1ZW49BJBXE116SV1AX`) | permissions page |
| Encoding handling | no | Claude Code refuses non-UTF-8 Edit rather than corrupt | Reference server and others lack encoding awareness | tools-reference 264-270 |
| Line-ending / indentation preservation | no | CRLF and indentation preserved by `edit_file` | Mixed-style files | CHANGELOG #5011, e0bf956c |
| Size / token caps | yes | 256 KB whole-file refusal, token cap | Server caps differ; none negotiable via protocol | tools-reference 514-521 |
| Large-file spill to disk | no | Claude Code spills >30k char output to session file | Not an fs-server concern; cross-tool convention missing | tools-reference 171-176 |
| Document formats (PDF/Excel/DOCX/URL) | no | DC reads them natively | Large attack surface; DC blocked | DC README 584-596 |
| Windows support | yes | UNC and drive-case fixes in 1.0.0 (#5009, #5010) | Still the biggest keyword cluster in the fs label (Windows 14 open/21 closed) | CHANGELOG 1.0.0 |

### D.2 Sandbox

| Feature | Base? | Great feature + why | Unsolved problem | Best code reference |
|---|---|---|---|---|
| Write confinement (allow-only) | yes | Writes denied everywhere except listed paths; `denyWrite` wins | Needs caches pre-listed or tools fail to spawn (the reason for `srt-policy.ts:164-192`) | srt README 120-125; local `srt-policy.ts:169-192` |
| Read confinement | yes | `denyRead` + `allowRead`; Claude Code `blockReadsOutsideWorkingDirectories` | Default is read-everything; srt #2 (14, open), #10 (11); Linux dirs hidden by tmpfs appear as writable empty dirs (srt README, Linux path-syntax notes under Filesystem Configuration) | srt README 113-120, 579-583; sandboxing page 527-535 |
| Network egress allowlist | yes | Domain wildcards with optional port; deny wins | Domain fronting; broad domains (github.com) leak; TLS not inspected by default | srt README network config; sandboxing "Security limitations" |
| Resolved-address / metadata guard | yes | Blocks loopback, link-local and cloud-metadata after DNS | Private ranges allowed by default (needs `deniedResolvedAddresses`) | srt README network config |
| Credential protection | yes | `deny`/`mask` env vars and files; local `defaultSrtDenyRead` | Mask requires TLS termination (experimental) | srt README `credentials`; `srt-policy.ts:150-159` |
| TLS termination / request filtering | no | `filterRequest`, header rewrite, `requireHostMatch` | Go clients on macOS fail TLS (Claude Code #23416 69, #29533 33) | srt README network |
| Unix socket control | yes | Blocked by default; seccomp on Linux | Path allowlist ignored on Linux (seccomp cannot filter by path) | srt README unix-socket table |
| Local binding / localhost | yes | `allowLocalBinding` | Not implemented on Linux (srt #165, 21) and lifted outbound TCP once (#225) | srt issues |
| Process / pid / ipc isolation | yes | `--unshare-pid`, `--unshare-user`, fresh `/proc` (Codex) | Containers without userns (Ubuntu 24.04 AppArmor, srt #74) | Codex linux-sandbox README |
| Syscall filtering | yes | seccomp blocks `io_uring`, `AF_VSOCK` | x64/arm64 only in srt | Codex linux-sandbox README; srt README |
| Resource limits (CPU/mem/pids/time) | yes | Claude Code cgroup memory cap; microVM/container quotas | Neither srt nor tumf provide it; delegated to container (tumf README 63) | tools-reference 223-247 |
| Mandatory deny / protected paths | yes | Auto-blocked rc files, hooks, MCP config, with pinned ancestors on Linux | Rigid lists (srt #159); search depth limited to 3 by default | srt README 914-962 |
| Escape hatch governance | yes | Unsandboxed retry gated by ask rule; strict mode removes it | Allow rules silently approve retries (Claude Code doc) | sandboxing "unsandboxed retry" |
| Cross-platform backend | yes | Seatbelt + bwrap + Windows (srt alpha, Codex MXC, Gemini icacls) | WSL1 unsupported (Codex), Windows setup failures (Codex #51601 31) | srt README 103-110; Codex security doc |
| Per-spawn policy file | yes | `srt -s <path>` per run | Content-addressed per-run file needed to avoid global growth | `srt-policy.ts:16-22`; `catalog.ts:200-230` |
| Violation reporting to the model | no | `<sandbox_violations>` line, `deniedDomainReasons` | Residue/dotfile leaks on SIGKILL (srt #139, 77) | srt README network config; issue #139 |
| Nested sandbox (inside Docker) | no | `enableWeakerNestedSandbox` | Considerably weaker (Claude Code doc) | srt README Other Configuration |
| Hardware isolation tier (microVM, gVisor) | no | Firecracker (E2B), gVisor `runsc` (Gemini), microsandbox | Remote/cloud latency or ops cost; E2B/Daytona perf figures are vendor claims (U) | e2b-dev/infra README; Gemini sandbox.md 199-222 |
| Landlock path | no | Unprivileged, no userns | srt #41 (11, open); Codex rejected it for Unix socket isolation | landlock.rst; Codex README |

### D.3 Shell

| Feature | Base? | Great feature + why | Unsolved problem | Best code reference |
|---|---|---|---|---|
| Argv-only exec (no shell string) | yes | Removes metacharacter injection | Interpreters/launchers inside allowed programs still execute code | tumf README 16-19; `catalog.ts:103-111` |
| Command-name allowlist | yes | Simple, auditable | Bypass via arguments: 14 advisories in 2 months | tumf advisories (3.3) |
| Pattern allowlist (regex on names) | no | `ALLOW_PATTERNS` fullmatch | Matches names only, not argv (C `01M4E39RHKF4XFF7TE7BBFDDBD`) | `resolver.ts:332-340` |
| Argument hardening denylist | yes | Rejects `find -exec`, `git -c`, sort/awk/sed vectors | Non-exhaustive by its own README (line 50); chasing new vectors | tumf README 50; GHSA list |
| Per-command deny / exemption | no | Codex `forbidden` + justification; Gemini `deny` + message | tumf has none; request #51 (closed) for exemptions; local code rejects a fictional deny env (`resolver.ts:346-351`) | Codex execpolicy README; Gemini policy-engine |
| Argv-prefix policy with tests | no | `match`/`not_match` examples validated at load | Prefix rules only; richer language promised, not shipped | codex-rs/execpolicy/README.md 1-40 |
| Compound command handling | yes | Claude Code splits `&&`, `|`, `;` and matches each | Prompts fire on wrong subcommand (#28240, 209) | permissions page 217-262 |
| Wrapper stripping | no | Fixed list so `timeout 30 npm test` matches | Env runners (`npx`, `docker exec`) not stripped; rule of thumb "not a security boundary" | permissions page 233-262 |
| Contained redirection | yes | Targets must stay under cwd | Only for server-managed redirection | tumf README 21 |
| Minimal child env | yes | Default child env is `PATH` only | Breaks proxy vars under sandbox; needs allowlist (`MCP_SHELL_CHILD_ENV_ALLOWLIST`, fixed in 0ba70e47) | `catalog.ts:131-137`; `resolver.ts:353-377` |
| Exit status surfacing | yes | Local launcher shim (61358b6f) | UNVERIFIED inference: the shipped tumf result appears to lack a first-class exit status, since the host added a launcher shim (commit 94b48cce subject: "surface shell exit status via a PATH launcher shim") | `catalog.ts:138-142`; `resolver.ts:359-367` |
| Timeout + output cap | yes | server-side default/max/byte cap | Spill-to-file for large output exists in Claude Code, not in tumf | tumf README 20; tools-reference 154-176 |
| Background / long-running | yes | `run_in_background`, `Monitor` (Claude Code); interactive sessions (DC `start_process`) | tumf has a single synchronous tool (`catalog.ts:121`) | tools-reference 180-221; DC README 577 |
| Interactive stdin / REPL / PTY | no | DC ready-detection; srt `allowPty` (macOS) | PTY under sandbox is opt-in | DC README; srt README Other Configuration |
| cwd control | yes | Spawn cwd resolved at task time | Must be inside `allowWrite` | `resolver.ts:292-300, 383-388` |
| Ask / HITL | yes | Host-level suspend/escalate/deny chain | In-server HITL only in mako10k (C, 6 stars); non-interactive asks hang elsewhere (opencode #13715, 32) | ADR-0008 D6; opencode issue #13715 |
| Audit log | no | Structured, redacted | External anchoring proposal still open (tumf #59) | tumf README 23 |
| Resource limits | yes | Not provided by tumf | Must come from sandbox/container | tumf README 63 |
| Exec in a hardware sandbox | no | Container/microVM shells (agent-infra/sandbox 6,140 stars, E2B) | They replace the whole toolset rather than slot in as a server (C `01M47X73MXJMFKYH8PD4VWKV4F`) | memory (C) |

## 6. Local comparison and build-vs-integrate verdict

Local design read (grade A): `catalog.ts` (fs launched as `node <resolved bin>` from a pinned dependency lines 46-100; shell via `uvx --from mcp-shell-server==1.1.12` lines 113-121; default allowlist 161-168; `wrapWithSandbox` 198-230), `resolver.ts` (root-hint containment 176-220, fs roots 238-278, shell env/allowlist/proxy/exit-shim 316-391, `withSandbox` 146-157), `srt-policy.ts` (credential `denyRead` 150-159, write caches 169-192, PyPI-only egress 137-141, per-run policy 16-22), ADR-0008 D5/D7 (gate is thin and tool-name only; hard enforcement delegated).

Verdicts:

1. **fs server: INTEGRATE (keep).** No server found beats the reference on breadth, trust and maintenance (91,149-star monorepo, 447k weekly npm; memory verdict `01M47XA8VZDC5V67KZ44M0SBGK` re-confirmed by the label-scoped tracker data above). Evaluate (do not blindly take) a bump from 2026.7.10 to 1.0.0: post-pin commits include move_file refusing to overwrite (cda92bda), permission preservation (562feeb2), in-place overwrite (7dc802f9, #4512), Unicode path resolution (f621c75a, cf05b376), roots revocation (bea1c9a1) per `gh api .../commits?path=src/filesystem/lib.ts&since=2026-07-10`. Caveat: 1.0.0 was published hours before this report and is "the last release on the 1.x SDK" (CHANGELOG line 3-4); whether it works with agent-mcp's client is UNVERIFIED. Watch-list: rust-mcp-filesystem (180 stars, RO default, content grep) and mcp-workspace (per-root RO) (C).
2. **shell server: INTEGRATE (keep), but treat the allowlist as hygiene.** tumf remains the only cross-platform argv-allowlist MCP shell with an honest contract (C `01M47X72D71RX2YVW8JS8139RW`); the 14 advisories show the argument-denylist is a moving target, so the pin should be bumped promptly on each patch release (as it was to 1.1.12). Do not expand `DEFAULT_SHELL_ALLOW_COMMANDS` with more launchers. For a different need, interactive sessions (DC-style) are absent and would need a second server; DC itself stays BLOCKED.
3. **sandbox: INTEGRATE srt (keep).** It is the most complete open fs+network sandbox for arbitrary processes (features S1-S6), is endorsed for wrapping MCP servers by its own README, is used by ipybox and by Claude Code's runtime, and has 556k weekly downloads. Pin `^0.0.78` is exact; 0.0.79 exists.
4. **BUILD only the thin policy compiler.** The evidence says the remaining defects (O1-O4) are all drift between layers, and the best external design (Claude Code S9) is a single policy intent compiled to every enforcer. The thing to build is small and local: one declarative workspace policy that derives (a) fs server roots, (b) srt `allowWrite`/`allowRead` plus a read-scope `denyRead`+`allowRead`, (c) the egress domains matching the advertised allowlist, and (d) shell cwd. No upstream tool offers this across a third-party fs server, a third-party shell server and srt, so it is not an integrate candidate. This is a conclusion from the cited evidence, not an ADR change: it needs the ADR-0008 Amendment A1 research/test/decide process before any implementation (ADR header, line 3).
5. **Do not import** Codex execpolicy or Gemini policy TOML: ADR-0008 D5 deliberately keeps the host out of command parsing, and #30519 (79) plus the tumf advisories are the cost of the alternative. They remain design references (testable `match`/`not_match`, justification strings).

## 7. Memory episodes written this run

Written via `memory_write_batch` (project_path `/Users/nix/dev/node/adhd`), topic `agent-mcp-native-tooling`, one episode per finding:

- `01M4PNB8CR1ZM3KSRYVJN3A7QJ` tumf: 14 advisories, pin 1.1.12 first fully patched
- `01M4PNBCQ1DJ2MHTG69NAT9H2Z` fs server 1.0.0 vs pin 2026.7.10
- `01M4PNBCT3CQHPP205KP5H5W9M` srt features and demand stats
- `01M4PNBCXEBFC4Z6ESMJDPJM6H` pattern: one policy intent compiled to every enforcer
- `01M4PNBD0H4Q8YB0GWXM6YH43Z` candidate local overlap bugs O1-O3 (unexecuted)
- `01M4PNBD48KM20X7GM51MV8MPZ` Codex / Gemini / opencode reference
- `01M4PNBD81KAQBZ7WZEMW9MKD8` DesktopCommander refresh (BLOCKED)
- `01M4PNBDBJ79E60Q78NY9A91M0` container / microVM tier snapshot

## 8. UNVERIFIED and open items

- No behaviour in section 4.2 was executed (O1 read escape, O2 egress starvation); they follow from code and docs reading. A live check through the real agent-mcp tools is the proof owed.
- fs 1.0.0 compatibility with the agent-mcp stdio client: not tested.
- rust-mcp-filesystem, mcp-workspace, mako10k, sonirico, inercia feature claims: memory only (grade C, 2026-10-06..08), not re-fetched.
- Docker `mcp/filesystem` image, gVisor flags beyond what Gemini's doc states, Firecracker jailer details, Daytona isolation internals: not fetched. Daytona "under 90ms" and E2B resume claims are vendor statements.
- Codex `apply_patch`/file-edit sandboxing relative to the shell sandbox: not verified (only shell sandbox docs read).
- Claude Code core source is closed; all Claude Code behaviour is from official docs (grade A for docs, U for implementation).
- Issue-count caveat: GitHub search matches title/body/comments; counts are indicative. Thumbs-up counts are body reactions only.
- DesktopCommander has no GitHub-published advisories via API, but SECURITY.md was not read.

## 9. Trace (process notes)

Phases 0-7 followed. Searches: gh API (about 60 queries), WebFetch x6, raw README/source fetches x15, memory recall/entity search x2. Rate-limit/block events: 0. Substitution disclosed: used `gh api` and raw.githubusercontent for counts and source rather than the `mcp__search__` providers, because the former return exact counts; WebFetch handled vendor docs. Process failure caught: first keyword batch used unsupported OR syntax (identical totals), discarded, redone label-scoped. One improvement for next run: pre-scope every tracker query with `label:` or `in:title` from the start.
