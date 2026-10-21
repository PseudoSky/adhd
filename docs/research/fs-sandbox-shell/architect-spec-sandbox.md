# Architect spec: sandbox (kernel confinement and launcher)

Status: draft for owner review. Behaviors only; creates no package, installs nothing. Companion to `architect-spec.md`, which owns the policy library and defines effective attributes (`resolve`, CL-10), `narrow` (CL-09) and residual constraints (RS-*). This file specifies how a launcher turns those outputs into real confinement. Policy defines no routing to processes (RS-01); the mapping below is the launcher's own. Format, status codes and ID resolution: see `architect-spec.md`.

The sandbox is a separate package and is never part of `@adhd/policy` (SC-03, SO-01). Creating it needs its own approval.

## 1. Kernel sandbox (SB)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SB-01 | The sandbox engine MUST be the existing open-source `sandbox-runtime`. This work MUST NOT build an engine. | D1 > Variants; D4 > File 2 | S |
| SB-02 | The kernel read and write scope MUST come from the effective attributes through the launcher's own configuration (RS-01). | D4 > File 1 (handoff, now launcher-owned) | S |
| SB-03 | Network scope MUST come from the `net.connect` permissions. Metadata addresses MUST be denied. | D4 > File 1 (net) | S |
| SB-04 | The kernel read-deny set MUST include the secret and protected-path patterns, so a flag the Layer cannot see (for example `rg -f .env`) is refused with a permission error. | D4 > File 1 (files.* deny); D2 > Gateway limits | S |
| SB-05 | Compilation to the kernel MUST be monotone: if one principal's attributes are within another's, its kernel scope MUST be within the other's. | (design rule from nested-sandbox discussion) | O |
| SB-06 | The kernel projection MAY over-approximate what policy allows. The policy Layer MUST be exact on calls it sees. Unmediated actions are bounded only by the projection. | (design rule from nested-sandbox discussion) | O |
| SB-07 | A permission that cannot be expressed to the kernel (regex on paths, amounts, rates) MUST be enforced at call time only and be reported as such. | D3 > explain | O |
| SB-08 | If the sandbox cannot be established for a process that requires one, the process MUST NOT run. | D1 > Variant B | S |
| SB-09 | Sandbox violations MUST be recorded and available to read. | D1 > Variant A (sbx violations) | S |
| SB-10 | A readiness check (`doctor`) MUST report platform support and known blockers before first use. | D1 > Variant D; D1 > Common | S |
| SB-11 | The sandbox protects against what a process does internally, not against a compromised host. | D1 > Common (ceiling) | S |

## 2. Sandbox tools: mount and exec (SX)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SX-01 | `sandbox.mount` MUST take a server name that resolves to an entry in `.mcp.json` and an optional `grant` and `only`. | D4 > File 1 (sandbox permissions) | U |
| SX-02 | `sandbox.exec` MUST take a binary name that resolves on the sandbox's PATH, plus arguments. A path or a command line MUST be rejected. | D4 > File 1 (sandbox.exec) | S |
| SX-03 | Which servers and binaries a caller may reference MUST be decided by permissions on the `server` and `bin` arguments. | D4 > File 1 | S |
| SX-04 | An agent MUST NOT be able to run an arbitrary command through `sandbox.exec`. It names a target, not a command line. | D4 > File 1 | S |
| SX-05 | A mounted server's tool calls MUST be evaluated with the mounted instance's attributes. | D4 > File 1 (sandbox.mount) | S |
| SX-06 | Arguments to a `sandbox.exec` binary are not filtered by the Layer. The sandbox bounds them. | D4 > File 1 | S |
| SX-07 | The launcher MUST add the runtime files a server or binary needs to its read scope, separate from the caller's roots. | D4 > Host contract and assumptions (runtime files) | O |
| SX-08 | A mounted server needs a distinct instance name so its tools can be addressed. | D4 > Host contract and assumptions (instance naming) | O |
| SX-09 | A sandboxed process that creates a child MUST do so through the Layer, subject to NR-01 to NR-07. | D4 > File 1 (narrowing) | S |

## 3. Sandbox feasibility proof (SP)

The sandbox is not assumed. Each item below MUST pass on macOS and on Linux before a design that depends on it is built.

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SP-01 | A process started by the launcher with a read and write scope derived from effective attributes can read and write inside it and is refused outside it. The refusal is a kernel permission error, not a cooperative check. | RS-01, SB-02 | U |
| SP-02 | Scope is derived by the launcher alone from `resolve` plus `narrow` output. The sandboxed process cannot widen it. | SI-01 | U |
| SP-03 | A sandboxed process can reach the serving process (local socket or loopback port) while having no other network. | GW-07, SB-03 | U |
| SP-04 | A sandboxed process can start a second sandboxed process with a narrower scope, and the inner process cannot touch anything outside the inner scope. | SX-09, PS-04 | U |
| SP-05 | A nested start cannot widen scope. An attempt to start with a wider scope fails or is bounded by the outer sandbox. | NR-01, SB-05 | U |
| SP-06 | A mounted MCP server runs inside the sandbox and the serving process for it runs outside it, and the host reaches the server through that process. | SX-05 | U |
| SP-07 | The runtime files a server needs (node, python, libraries, temp directories) are provisioned automatically in the read scope. | SX-07 | U |
| SP-08 | A hidden-argument read (`rg -f .env`) is refused by the kernel after the Layer allowed the call. | PS-06 | U |
| SP-09 | A symlink out of a root and a macOS `/tmp` to `/private/tmp` path are resolved before comparison and are refused or allowed correctly. | AP-08 | U |
| SP-10 | Violations are recorded and readable after the process exits. | SB-09 | U |
| SP-11 | The launch overhead and the per-call overhead of the sandbox are measured and reported. | GW-16 | U |
| SP-12 | Each result is recorded per platform (macOS, Linux) and per Linux user-namespace setting. Items that fail MUST produce a recorded design change, not a silent skip. | PL-02, PL-03 | U |
| SP-13 | The proof runs by default in CI as part of the policy package's test lane, with a loud failure if the sandbox prerequisite is missing. | AGENTS.md live-testing rule | S |

## Rows moved from the policy spec (SM)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PL-02 | On Linux distributions that restrict user namespaces, `doctor` MUST report the blocker before first use. | D1 > Common | S |
| PL-03 | Nested sandbox behavior MUST be established per platform by the proof suite. It MUST NOT be assumed. | (spike plan) | U |
| FC-02 | A sandbox that cannot be established MUST cause the process not to run. | D1 > Variant B | S |
| AU-03 | Sandbox violations MUST be available to the agent and the operator. | D1 > Variant A | S |
| IN-08 | The sandbox tools (`sandbox.mount`, `sandbox.exec`) MUST be apigen operations mounted on MCP and served through the apigen host with the policy Layer, so the advertised schema, the arguments permissions filter, and the function parameters are one definition. | SX-01, SX-02 | S |

## Proof suite (SPS)

| ID | Test | Behaviors covered | Negative control |
|---|---|---|---|
| PS-01 | Same intent through the filesystem tool and the shell inside the real sandbox gives the same allow or deny for about 30 cases (secret file, symlink out of root, rename of a protected path, write to a hook, metadata address, secret env var). | RS-04, SB-02, SB-04, TL-01, TL-02 | Remove the matching kernel scope output |
| PS-06 | A command with a hidden argument (`rg -f .env`) is refused by the kernel after the Layer allows the call. | SB-04, GW-14 | Remove the read-deny output |
| PS-07 | A sandbox that cannot be established runs nothing. | SB-08, FC-02 | Fall back to unconfined |
| PS-14 | Nested sandbox behavior is recorded per platform. | PL-03 | Not applicable |
| PS-15 | Every SP item passes on macOS and Linux through the real launcher. | SP-01 to SP-13 | Replace the kernel scope with unconfined |

## Open decisions (SO)

| ID | Decision | Current default | Affects |
|---|---|---|---|
| SO-01 | Package name and approval. The sandbox is a separate package, never inside `@adhd/policy`. | Separate package | all |
| SO-02 | Where `denyRead` and `network` come from: the launcher's configuration over `resolve` output, or the proposed `residual` query (OD-21). | Launcher configuration | SB-03, SB-04 |
| SO-03 | How a mounted server receives its child attributes (DL-02). | Undecided | SX-01, SX-05 |
| SO-04 | Drivers beyond `sandbox-runtime`. | `sandbox-runtime` only | SB-01 |
| OD-03 | Instance naming for mounted servers. | Undefined | SX-08 |
| OD-08 | How runtime files for a server or binary are derived. | Undefined | SX-07 |
| NG-06 | The system does not build a sandbox engine. | D1 > Variants |
