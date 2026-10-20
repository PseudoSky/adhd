# Proposal: a policy-driven filesystem, sandbox and shell toolset for agents (client + MCP each)

Date: 2026-10-11. Author: product. Status: RECOMMENDATION FOR OWNER APPROVAL. Nothing here scaffolds a package, installs a tool, or publishes anything (AGENTS.md: new packages, new root folders and external tools need explicit human approval).

Citation key: [R §n] = /private/tmp/claude-502/-Users-nix-dev-node-adhd/f118b5b4-5fc4-458b-9f31-9ac647bb0cab/scratchpad/fs-sandbox-shell-research.md section n (grade A/B/C/U as defined in R §0). [ADR8] = /Users/nix/dev/node/adhd/docs/decisions/0008-agent-mcp-native-tooling.md. [mem uid] = researcher memory episode (R §7). URLs are the ones the research file cites. UNVERIFIED = I could not confirm it. No extra web discovery was dispatched: the research file and its memory episodes were sufficient for every decision below; gaps are listed as UNVERIFIED rather than filled by recall.

## 0. The answer in one paragraph

Do not build three competing products. The evidence says two of the three incumbents are good enough to keep and extend, and one is weak. The thing nobody ships is a single declared policy that confines the file tool and the shell identically, host-agnostic, as open MCP servers. Build that: (1) the policy compiler plus a thin sandbox client over srt, (2) a sandbox-native shell MCP, and (3) a policy-aware filesystem MCP only if it clears a gate. Do not rebuild srt. Do not rebuild the reference filesystem server's core unless upstream and the 1.0.0 line cannot close the gaps. Headline verdict: GO on the set, narrowed to "one policy, three enforcers"; GO shell; GO sandbox as a thin client only; fs CONDITIONAL behind a gate.

## 1. Go/no-go with the explicit test

### 1.1 The test: "genuinely better than what exists"

An item passes only if all four hold:

- T1 Capability gap: a property incumbents lack, named and testable (not "nicer").
- T2 Demand: that property appears in incumbent trackers as reactions or repeated issues (R §3).
- T3 Not cheaper elsewhere: the gap cannot be closed by configuration, an upstream PR, or adopting a newer incumbent release at lower cost.
- T4 Provable: a default-running test with teeth (AGENTS.md section 7) can show our version succeeds where the incumbent fails.

### 1.2 Verdicts

| Item | Verdict | One-line reason |
|---|---|---|
| Shell | GO | Clear T1-T4. Incumbents are either unsafe (DesktopCommander, 10,001 stars) or a moving denylist (tumf, 14 advisories in about 2 months). |
| Sandbox | NO-GO on an engine; GO on a thin client/compiler | srt has 5,509 stars, 556,025 weekly npm downloads, Apache-2.0, and its documented gaps are policy gaps, not engine gaps. Rebuilding fails T3. |
| Filesystem | CONDITIONAL (gate G2) | Real gaps exist but the incumbent is huge (447,296 weekly) and just shipped 1.0.0. Passes T1/T2, fails T3 until upstream is tried. |
| The set | GO, as "one policy, three enforcers" | The cross-layer gap (R §4.2 O1-O4) is real, unsolved by any open host-agnostic tool, and provable (T4). |

### 1.3 Evidence per item

Shell, for:
- DesktopCommander is the market leader (10,001 stars, 202,332 weekly npm) yet its own README says directory limits and command blocking "can be bypassed ... symlinks, command substitution, and absolute paths", that `allowedDirectories` restricts only fs operations and not terminal commands, and that the model may rewrite its own config [R §3.4, §2 F13]. Popular and unsafe: the demand is there, the product is wrong.
- tumf/mcp-shell-server: 201 stars, 1,210 weekly PyPI, 14 published advisories (11 high) between 2026-07-18 and 2026-09-19, each a bypass through an allowed program (awk, git, sort, sed, find) [R §3.3]. The README itself says it is not a sandbox and lists six properties an external boundary must supply [R §2 H2]. The model (argv denylist) is a treadmill; 1.1.12 is only the first fully patched release.
- No shell MCP ships a hard OS sandbox as a drop-in: five attempt it, none is drop-in [R §0, mem 01M47X72D71RX2YVW8JS8139RW, grade C].
- Demand for a real sandbox: opencode #2242 "Is there a way to sandbox the agent?" 78 thumbs-up, 96 comments, open; #9132 Docker sandbox template 42 [R §3.7]. Claude Code sandbox tracker: 902 issues with "sandbox" in title (195 open) [R §3.8]. Codex label:sandbox: 2,615 issues [R §3.5].
- The local stack already shows the cost of the current shape: the default allowlist contains code-exec launchers (npx, make, npm, pnpm, nx, tsc, uv, git, awk) so "the srt policy, not the allowlist, is the control that matters" [R §4.2 O3]; tumf has a single synchronous tool and no first-class exit status (a launcher shim was added) [R §5 D.3, U on the status claim].

Shell, against:
- tumf is honest, maintained (last push 2026-10-06), MIT, and works today wrapped by srt [R §6.2]. A rebuild must beat a patched, wrapped incumbent, not a strawman.
- Shipping a security-adjacent server public makes us an advisory target (see risks).

Sandbox, against building an engine: srt is endorsed for wrapping MCP servers by its README, is used by Claude Code's runtime, and its top issues (#139 residue 77 thumbs-up, #165 local binding 21, #105 Windows 16) are engine bugs best fixed upstream [R §3.2, §6.3]. Sandbox, for a thin client: the two read-scope issues (#2 14 thumbs-up open, #10 11) and the local O1 escape are solved by emitting `denyRead` plus `allowRead` from a policy; srt can already express it (README lines 579-583) but the local policy does not emit it [R §4.2 O1].

Filesystem, for: no read-only flag and no content grep in the reference server (open read-only mentions 12; exclusions #2219, #2308, #4208; #5074 asks the README to say it is a reference implementation and point to alternatives) [R §3.1, §5 D.1]. Codex #2847 "exclude sensitive files" has 470 thumbs-up [R §3.5]. Against: the reference server has 91,149-star monorepo trust, 447,296 weekly downloads, active fixes (symlink containment, in-place overwrite, roots revocation, Windows/UNC) and 1.0.0 published 2026-10-11; rust-mcp-filesystem (180 stars) already offers read-only default and grep [R §1, §6.1, grade C]. Bumping to 1.0.0 is untested here (UNVERIFIED) [R §8].

The set, for: the strongest external design (Claude Code) merges permission rules and sandbox settings into one enforcement set, but it is closed source, Claude-Code-only, and its own Read/Edit tools run outside the sandbox ("a denyRead entry doesn't stop the Read tool") [R §4.3, §2 S9]. Codex does one policy for commands inside Codex. Gemini's workspace policy tier is non-functional (#18186). opencode has no OS sandbox [R §4.3]. No open, host-agnostic MCP toolset does it. This is also precisely the drift found locally (O1 read escape past the fs allowlist, O2 egress starving advertised tools, O4 one intent in three configs) [R §4.2]; those are code-reading findings, NOT executed (UNVERIFIED behaviour, R §8).

## 2. The split, the policy, and where each rule lives

### 2.1 Ownership

| Unit | Client | MCP server | Owns | Does NOT own |
|---|---|---|---|---|
| Sandbox (thin) | `WorkspacePolicy` types, compiler, srt launcher/lifecycle, violation reader | `sandbox` tools: `policy_effective` (read-only), `violations`, `request_expansion` (host-gated ask) | The one policy model; compilation to every enforcer; kernel confinement via srt (fs read/write, egress, descendants); residue cleanup; violation feed | The sandbox engine (srt owns it); any tool that lets the agent edit its own policy (DesktopCommander flaw, R §3.4) |
| Shell | spawn client + typed result | `shell` tools: `exec`, `exec_background`, `job_status`, `job_output`, `job_kill` | Execution semantics: argv-exec, cwd, child env allowlist, timeouts, output caps and spill, exit status, jobs, audit log, optional command-name hygiene | Confinement (delegated to sandbox), the permission gate |
| Filesystem | policy-aware client | `fs` tools (read, write, edit, move, list, tree, glob, grep, read_media) | Tool semantics: symlink-safe ops, edit safety, bounded reads, annotations, protected paths, sensitive-file refusal | Kernel confinement of the shell (sandbox) |
| Host (agent-mcp, unchanged) | existing | existing | Thin tool-NAME gate, HITL, fail-closed asks [ADR8 D5, D6] | Command parsing, dangerous-command catalogs [ADR8 D5] |

Rule of thumb carried from the research: whichever layer a child process can bypass is advisory. Only the sandbox sees every descendant, only the shell sees argv, only the fs server sees tool semantics, only the host sees tool names and the human [R §4.1].

### 2.2 The single compiled policy

One declarative `WorkspacePolicy` (intent, resolved at task time against the dispatching cwd, definition never mutated [ADR8 D4], typed in `@adhd/environment` with no env toggles [ADR8 D10]):

- `roots[]`: path plus mode `rw|ro`.
- `read`: scope `workspace-only | roots+system-minimum | custom`; sensitive globs (default: `*.env`, `*.env.*`, key/credential files; `!*.env.example`), gitignore-style with negation.
- `protected[]`: subpaths read-only inside writable roots (`.git/hooks`, rc files, `.mcp.json`, agent config); overridable per project to avoid srt #159 rigidity.
- `egress`: domain allowlist, `deniedResolvedAddresses`, metadata guard on, localhost rules.
- `credentials`: env vars and files with `deny|mask`.
- `limits`: wall time, output bytes, optional cgroup memory/pids where the platform allows.
- `shell`: cwd, child-env allowlist, optional command-name hygiene list (explicitly advisory).
- `escape`: `none | host-gated` (default `none`; Claude Code's gated retry is the model, strict mode is our default) [R §2 S7].

`compile(policy) -> CompiledPolicy` emits, from the same record:

| Output | Consumer | Replaces (today) |
|---|---|---|
| fs roots and tool filtering | fs server | `resolveFsRoots` args [R §4.2 O4] |
| srt settings (allowWrite, denyWrite, denyRead+allowRead, domains, credentials), content-hashed per-run file | sandbox/srt | hand-assembled `srt-policy.ts` |
| spawn cwd, child env, proxy env, limits | shell server | `catalog.ts` env/allowlist wiring |
| MCP ToolAnnotations / gating hints | host gate | none |

Where each policy dimension lives follows the table in R §4.1 unchanged (reads, writes, protected paths, egress, descendants: sandbox-enforced; argv hygiene, timeouts, output: shell; tool semantics: fs; tool-name ask/deny: host). New in this proposal: the policy is the only input; the three enforcers cannot disagree because they are derived, and a conformance suite proves it (section 2.3).

### 2.3 The proof that makes it a product (T4)

A default-running conformance suite ("probe matrix"): for every policy case, issue the same intent through the fs tool and through the shell, both inside the real sandbox, and assert identical allow/deny. Cases include the live O1 case (`cat /outside/.env` via shell vs fs read), symlink out of root, rename-away of a protected path, write to `.git/hooks`, egress to a metadata address, and secret env var visibility. Teeth: each case must go red when the matching compile output is removed (negative control), per AGENTS.md section 7 rules 2 and 6. This is also the first thing to run to turn R §4.2 from "reading" into "executed fact" (see kill criterion K1).

## 3. Feature set, prioritized

Legend: M must, S should, C could. Demand column cites R; "ref" = source we study (section 4).

### 3.1 Policy compiler and sandbox client

| P | Feature | Demand / rationale |
|---|---|---|
| M | WorkspacePolicy schema plus compile to fs roots, srt settings, shell spawn | O1-O4 [R §4.2]; CC S9 design [R §2] |
| M | Workspace-only read scope (`denyRead`+`allowRead`) | srt #2 (14), #10 (11); CC `blockReadsOutsideWorkingDirectories` [R §3.2, §2 S8] |
| M | Sensitive-file defaults and protected subpaths | Codex #2847 (470), opencode `.env` default deny, srt mandatory deny [R §3.5, §2 F10-F11] |
| M | Credential `deny|mask`, resolved-address/metadata guard on by default | srt S2/S3 [R §2]; DNS exfil #88 (15) [R §3.2] |
| M | Per-run content-addressed policy file, residue cleanup | srt #139 (77), #85 (31), `srt-policy.ts` per-run pattern [R §3.2, §2 S6] |
| M | Violation feed returned to the model | srt violation store [R §5 D.2] |
| S | `request_expansion` as a host-gated ask producing a one-run scoped grant | Gemini Sandbox Expansion Request [R §2 S12]; opencode #13715 shows asks must resolve (32) [R §3.7] |
| S | Backend probe with clear failures (bwrap/AppArmor, Seatbelt) | srt #74 (11), Codex #47345 (37), #15283 (32) [R §3.2, §3.5] |
| S | Policy profiles with `extends` | Codex profiles [R §2 S11] |
| C | Egress profile presets (package registries) so advertised tools are not starved | O2 [R §4.2] |
| C | Landlock/Windows backends | srt #41 (11), #105 (16) [R §3.2]; defer to upstream |

### 3.2 Shell

| P | Feature | Demand / rationale |
|---|---|---|
| M | Run-inside-sandbox by construction; refuse to start unconfined unless policy says so, loudly | #2242 (78), #9132 (42); DC README admission [R §3.7, §3.4] |
| M | Argv-only exec (no shell string), cwd, minimal child env with proxy passthrough | tumf H1 [R §2]; env fix 0ba70e47 [R §5 D.3] |
| M | First-class structured result: exit code, signal, stdout, stderr, truncated flag, duration | tumf lacks it (shim added; U) [R §5 D.3] |
| M | Timeout and output cap with spill-to-file and preview | Claude Code behaviour [R §2 H4] |
| M | Process-tree kill and cleanup on timeout/cancel | descendants rule [R §4.1] |
| M | Audit log (structured, redacted) | tumf [R §2 H1]; tumf #59 anchoring open [R §3.3] |
| S | Background jobs plus job status/output/kill | tumf single sync tool; Claude Code `run_in_background` [R §2 H4, H8] |
| S | Optional command-name hygiene list with load-time `match`/`not_match` examples, justification returned to the model, advisory by contract | Codex execpolicy H5; keeps tumf's honest-contract stance [R §2 H2, H5] |
| S | ToolAnnotations on every tool | Codex gating by annotation [R §2 F2] |
| C | Interactive PTY/REPL sessions (sandbox `allowPty` where available) | DC #10 WSL (13), start_process [R §3.4, §2 H8] |
| C | Compound-command text rules | NOT built: ADR-0008 D5 forbids harness-side parsing; Claude Code #28240 (209), #30519 (79) is the cost of the alternative [ADR8, R §3.8] |

### 3.3 Filesystem (all conditional on gate G2)

| P | Feature | Demand / rationale |
|---|---|---|
| M | Roots from compiled policy, live revocation on empty roots | MCP Roots [R §2 F1]; ADR8 D4 |
| M | Read-only mode, per root and global, plus tool filtering | open read-only mentions 12, #632 [R §3.1] |
| M | Sensitive-file refusal and protected paths, symlink-aware (realpath ancestors and target, `O_NOFOLLOW`, `wx`) | #4208, GHSA-hc55-p739-j48w, GHSA-q66q-fx2p-7w4m [R §3.1, §2 F3] |
| M | Exact-string edit with uniqueness, read-before-edit, dry-run diff, CRLF/indent preservation, non-UTF-8 refusal | F4, F6 [R §2] |
| M | Bounded reads: head/tail/line range, token cap with PARTIAL notice | F7 [R §2] |
| M | ToolAnnotations everywhere | F2 [R §2] |
| M | Windows path normalisation (casing, UNC, drive letters) | #470 (13), label-scoped Windows 14 open/21 closed [R §3.1] |
| S | Content grep and glob with gitignore awareness and symlink-aware excludes | no grep in reference; #2219, #2308, #4208 [R §5 D.1] |
| S | `read_media_file` | #533 (23, stale but present) [R §3.1] |
| C | PDF/Excel/URL readers | DC breadth with high attack surface; defer [R §5 D.1] |

## 4. Public code we reference, per feature

All are study-and-reimplement or depend-on; licence checks required before copying any code (UNVERIFIED for every repo marked "n/a" in R §1).

| Feature | Reference | Licence (R §1) |
|---|---|---|
| fs/network confinement engine | anthropics/sandbox-runtime (depend on it, do not fork); README lines 113-135, 579-583, 914-962 | Apache-2.0 |
| Linux carve-out ordering, protected subpaths, glob masking, seccomp | openai/codex `codex-rs/linux-sandbox/README.md` | Apache-2.0 |
| Policy profiles, network defaults | Codex permission profiles doc (learn.chatgpt.com/docs/agent-approvals-security) | doc |
| Merge-permissions-into-sandbox design | code.claude.com/docs/en/sandboxing, /permissions | docs only (closed core, U implementation) |
| Argv exec, env allowlist, audit, honest contract | tumf/mcp-shell-server README lines 8-66 | MIT |
| Testable prefix rules, `host_executable` | codex-rs/execpolicy README | Apache-2.0 |
| Rule schema, deny messages, admin tier | gemini-cli `docs/reference/policy-engine.md` | Apache-2.0 |
| Sandbox expansion request, mounts default `ro` | gemini-cli `docs/cli/sandbox.md` | Apache-2.0 |
| Permission-map semantics (last-match-wins, `external_directory`) | opencode.ai/docs/permissions | MIT |
| Symlink-safe ops, edit_file, roots, annotations | modelcontextprotocol/servers `src/filesystem` (`lib.ts` 151-188, 299-346, 371-379) | NOASSERTION (U: confirm licence before any copy) |
| Read-only default, grep | rust-mcp-stack/rust-mcp-filesystem (MIT); mcp-workspace (U licence) | memory grade C |
| Interactive sessions, document readers | DesktopCommanderMCP (MIT) as a feature reference only; BLOCKED as a dependency | MIT |
| Hardware isolation tier (future) | e2b-dev/infra, microsandbox, gVisor | Apache-2.0 / n/a |
| Landlock | kernel `landlock.rst` | kernel docs |

## 5. ROI assessment

### 5.1 Cost to build

Sizing basis: there is NO measured velocity for this repo in the research (UNVERIFIED). Figures are planning estimates in agent-dispatch terms (one bounded executor dispatch, per AGENTS.md section 13 fan-out rule: items over 5 go through a pipeline, not one looping dispatch), assuming TypeScript, CommonJS-only publish [ADR-0003 per AGENTS.md], and an owner-approved package list. Calendar assumes parallel waves and review gates.

| Workstream | Dispatches (est.) | Calendar (est.) |
|---|---|---|
| A. Policy schema, compiler, per-run srt provisioning, backend probe, violation feed, `request_expansion` | 14-20 | 2 weeks |
| B. Conformance probe matrix (real sandbox, negative controls; also executes O1/O2) | 8-12 | 1 week, parallel to A after A's first wave |
| C. Shell server (exec, structured result, spill, jobs, audit, hygiene list, annotations) | 25-40 | 3-4 weeks |
| D. Docs, e2e/verify targets, publish, live MCP-host proof | 10-15 | 1 week tail |
| Phase 1 total (A-D) | 57-87 | 5-6 weeks |
| E. Filesystem server, ONLY if G2 passes | 20-30 | 2-3 weeks after G2 |
| Run-rate after launch (srt bumps, advisories, MCP SDK) | 1-2 per week | ongoing; srt moved 0.0.78 to 0.0.79 inside one week [R §1] |

The expensive, uncertain part is not typing code; it is the per-OS enforcement matrix and the security-response duty of a published shell server.

### 5.2 What it replaces or de-risks

- Closes the local read-escape (O1), the egress/allowlist mismatch (O2), and the three-config drift (O4) at the root rather than by patching [R §4.2]; O3 (allowlist full of launchers) is demoted to hygiene by contract.
- Ends the pin-chasing treadmill on tumf: 14 advisories, a new high-severity bypass every 1-2 weeks through mid-September, and the local default allowlist includes the exact programs behind GHSA-8wm7, 7v25, 74g6 [R §3.3].
- Removes dependence on a 201-star, 5-open-issue single-vendor shell server for a safety-relevant role; keeps srt (not rebuilt) so we inherit its 556k-download hardening.
- Preserves ADR-0008: gate stays thin and tool-name only (D5), fs/shell remain optional integrations (D13), selection is research-test-decide (D7/A1) with this document as the research input.

### 5.3 Adoption upside (hypotheses, not forecasts)

No adoption data exists for a product we have not shipped; no analytics are available to me. What the evidence supports is the size of the adjacent audience, not our share of it:

- Shell: a hard-sandboxed, drop-in shell MCP targets the audience of DesktopCommander (202,332 weekly npm) who are told by its own README that it can be bypassed, and the audiences asking for sandboxing in opencode (#2242, 78 thumbs-up), Codex and Gemini [R §1, §3].
- Sandbox: srt itself has 556,025 weekly downloads; a compiler that turns one policy into srt settings rides that base [R §1].
- Policy compiler: unique, so no comparable number exists; its value is the conformance proof, not a download count.

Leading indicators to measure after launch (no baseline exists today): external installs of the shell package, external issues opened, hosts using the compiled policy outside agent-mcp, advisories received.

### 5.4 Positioning against alternatives

| Alternative | What it gives | Where ours wins | Where it wins |
|---|---|---|---|
| Reference fs + tumf shell + srt (today) | Works, honest | One policy, executed proof, structured results, jobs | Zero new code, larger fs trust base |
| DesktopCommanderMCP | Breadth, interactive, 10k stars | Confinement is real, model cannot rewrite policy | Features (readers, REPL), mindshare |
| Claude Code built-in | Merged permission+sandbox | Open, host-agnostic MCP, fs tool inside the policy | Native UX, zero setup |
| Codex / Gemini built-ins | Strong sandboxes | Usable from any host | Native integration |
| E2B / Daytona / microsandbox / gVisor | Hardware-grade isolation | Local, zero-infra, per-call speed (vendor figures U) | Stronger isolation for untrusted code |
| Container-wrapping the whole agent | Simple blunt boundary | Per-tool, per-path granularity | Simplicity |

## 6. Risks and kill criteria

### 6.1 Risks

1. srt is 0.0.x with an exact-patch pin effect; API churn and a pre-1.0 contract [R §1].
2. Platform reach: macOS and Linux solid, Windows alpha, WSL1 unsupported elsewhere, Ubuntu 24.04 AppArmor friction [R §3.2, §3.5]. A cross-platform claim we cannot honour is a product defect.
3. Upstream absorbs the idea: Claude Code already merges policy and sandbox; srt could add a policy compiler; the fs reference server could add read-only and grep. Our moat is host-agnostic MCP plus the proof, not a secret.
4. We become the advisory target: publishing a shell server repeats tumf's 14-advisory experience unless confinement, not argument filtering, carries the security claim.
5. Scope creep into the engine or the gate violates ADR-0008 D5 and D13.
6. Maintenance burden for a solo-owner project (run-rate 1-2 dispatches/week, est.).
7. Executed-proof debt: O1/O2 are inferred, not run [R §8]; the premise could shrink.
8. Licence uncertainty on fs reference code ("NOASSERTION") and several watch-list repos.

### 6.2 Kill criteria (any one halts or descopes)

- K1: The probe matrix, run against the current stack, shows O1 and O2 do NOT reproduce (shell cannot read outside roots, npm egress works). The premise weakens: reduce to documentation plus a bump.
- K2: srt (or Claude Code's published runtime) ships host-agnostic single-policy compilation covering fs tools, or the maintainers decline the read-scope/policy contributions and fork cost exceeds est. 10 dispatches: stop A, adopt upstream.
- K3: After a one-month public beta, fewer than 3 external consumers (non-adhd repos) and zero external issues: stop expansion, keep as internal library only.
- K4: A high-severity advisory is accepted against the shell server that is a confinement bypass (not an argument-filter hygiene issue): freeze publishing until root-caused; two in any 90 days: sunset the public server.
- K5: Cross-platform: the probe matrix cannot pass on both macOS and Linux CI within the phase-1 window: ship Linux/macOS-only with a stated support matrix or stop.
- K6 (fs gate G2): build the fs server only if, after (a) testing the 1.0.0 bump against the agent-mcp client and (b) filing upstream PRs for read-only, sensitive-file refusal and annotations, upstream has not accepted or answered within 30 days AND the probe matrix still fails on fs-tool cases. Otherwise fs stays integrate (policy compiler drives the incumbent's roots).

## 7. The pitch

Every agent shell is a trapdoor and every agent file tool is a different trapdoor. Give an agent a file tool that refuses `.env` and a shell beside it, and `cat .env` walks straight past it. The market's answer is a pile of denylists: the most popular shell MCP warns in its own README that it can be bypassed, and the best-maintained argv-allowlist server has had 14 security advisories in two months.

We ship the missing piece: write one workspace policy, and one compiler turns it into the file tool's roots, the kernel sandbox, and the shell's spawn environment. Same policy, same answer, whether the agent reaches for `read_file` or `cat`. A built-in proof suite runs both paths and fails the build if they ever disagree. The shell runs inside the sandbox by construction, returns real exit codes, spills big output, runs background jobs, and cannot be talked into editing its own cage.

Who uses it: teams running unattended coding agents on their laptops and CI who today choose between permission-prompt fatigue and no confinement; host and framework authors (opencode-style projects with 78-thumbs-up requests for a real sandbox) who want a drop-in, MCP-native answer; security reviewers who need an auditable "what can this agent touch" record. Why it wins: it is the first open, host-agnostic toolset where the boundary is one declared fact, enforced by the kernel, and proven by tests, instead of three configs that happen to agree.

## 8. Approvals requested and open questions

Approvals the owner must grant (nothing is created until then):
1. Public publishing of a shell server and a policy/sandbox client (AGENTS.md: publishing is pre-authorized after gates; creating packages is not).
2. New packages (proposed shape, subject to the package-naming checklist and generator): policy/sandbox-client (core tier, node), shell server (entrypoint), fs server (entrypoint, gated by G2), possibly a `sandbox` domain addition to `.adhd/workspace.json`. No scaffolding performed.
3. Amendment A1 research/test/decide record: this document as the research input, with the probe matrix as the test.

Open questions:
- Is "ship a single shell + policy product" acceptable in place of three symmetric products, given the evidence that fs and sandbox engines should be integrated?
- Is a Windows story required at launch?
- Is the target consumer first agent-mcp, or external hosts from day one?
- Naming and licensing (MIT to match the repo; cannot confirm upstream compatibility for fs reference code: UNVERIFIED).

## 9. UNVERIFIED register

- O1, O2 behaviour (code reading only) [R §8].
- Compatibility of `@modelcontextprotocol/server-filesystem` 1.0.0 with the agent-mcp stdio client [R §8].
- Shell exit-status absence in tumf (inference from the local shim) [R §5 D.3].
- Claims about rust-mcp-filesystem, mcp-workspace, mako10k, sonirico, inercia (memory only, grade C) [R §8].
- Daytona/E2B/microsandbox performance numbers (vendor claims) [R §8].
- All effort and calendar estimates in section 5.1 (no measured velocity).
- Licences marked NOASSERTION/n/a in R §1.
- Adoption outcomes (section 5.3): hypotheses only.
