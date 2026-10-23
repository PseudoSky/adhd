# Architect spec: expected behaviors for the policy system

Status: draft for owner review. This document lists expected behaviors only. It creates no package, installs nothing and publishes nothing.


## Companion files

| File | Contents | ID prefixes |
|---|---|---|
| `architect-spec.md` (this file) | The policy library: scope and boundaries, variants, attributes, permissions, filters, narrowing, the client API, and the wrapper that exposes it (apigen CLI, MCP and HTTP projections; `run` and `serve` over apigen sources) | SC VR LC PD PM FX AT RT LY MG NR AP RS DL EX AU FC SI PL NG PS OD QE CL CC EV BO SV IN |
| `architect-spec-sources.md` | The apigen `remote` and `bin` sources that let any MCP server, API or command be governed, the wrapping behavior and the ask flow | SRC GW AK WM and moved rows |
| `architect-spec-sandbox.md` | The sandbox launcher: a separate consumer of the client | SB SX SP and moved rows |
| `architect-spec-layer.md` | The apigen policy Layer plugin: a separate package that lets any apigen-served operation set consult the client | LP LPS |
| `architect-spec-examples.md` | Example hosts and example per-tool policies | DP TL PG |
| `research-auth-mechanisms.md` | Catalog of authentication mechanisms and how verified attributes reach an authorization layer (input to the auth boundary) | none |

IDs are stable across files. The policy library never authenticates a caller, owns a session, stores state or confines a process (SC-03). The sandbox, the auth layer and any counter or audit store are separate packages that meet policy at the ports in SC-04. Foreign servers and commands are governed through apigen sources (`architect-spec-sources.md`); the demos' `policy-gw` command is the working name of `adhd-policy serve`. A separate apigen Layer plugin package (`architect-spec-layer.md`) lets any apigen host consult the client; it shares no import edge with this package (LP-02, SV-18).

## How to read this document

- **Demo references.** `D1` = `architect-demo.md`, `D2` = `architect-demo-v2.md`, `D3` = `architect-demo-v3.md`, `D4` = `architect-demo-v4.md`. A reference reads `D4 > Rules > 1`, meaning the document, then the section, then the item. `D4` is the authoritative demo. Earlier demos are cited only for behaviors `D4` does not repeat.
- **Keywords.** MUST and MUST NOT are required. SHOULD is expected unless justified. MAY is optional.
- **Status column.**
  - `S` = specified in the referenced demo.
  - `X` = specified, and needs an engine extension that does not exist yet.
  - `U` = depends on an unverified assumption (see the demo's own caveats).
  - `O` = open decision (see section 21); the behavior shown is the current default.
- All tool, server and argument names are illustrative, as stated in the demos. The behaviors that matter are the rules, not the names. Where a demo's YAML shape differs from the shapes in these documents (the `defaults` rules), these documents govern.

## 0. Scope and boundaries (SC)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SC-01 | Policy is a library for defining, evaluating and applying authorization policies. It compiles declarative documents, evaluates a tool call against the caller's attributes and runtime values, returns an allow, ask or deny decision with forced argument values, narrows delegated attributes, and explains every result. | (new); owner direction | S |
| SC-02 | Policy is tied to no provider, framework, transport or tool. `core` and `service` MUST NOT name or import MCP, a shell, a sandbox, agent-mcp, apigen, an auth library or any example tool. Tool names are policy content. | (new) | S |
| SC-03 | These concerns are valuable and outside policy; they MUST NOT be baked into it: (a) authentication and attribute extraction; (b) ownership, lifecycle and storage of sessions; (c) process confinement; (d) credential storage and injection; (e) approval user interface; (f) storage for runtime counters and audit records. | (new) | S |
| SC-04 | Each outside concern meets policy only at a port or a data shape: attributes come in as data (AT-01); runtime values come in through `IRuntimeProvider` (RT-08); decisions and audit records go out (AU-01); an `ask` goes out as a decision; launch scope is derived from effective attributes (RS-01, RS-02). | (new) | S |
| SC-05 | Policy MUST work with no attributes, no runtime provider, no server and no file beyond the built-in default (AT-09, EV-06). | (new) | S |
| SC-06 | Importing the library MUST start nothing: no server, watcher, listener, subprocess or network access. MCP and HTTP servers start only on an explicit command (VR-07). | (new) | S |
| SC-07 | Code that knows about MCP, process spawning or apigen is a shell: the apigen entry files in `entrypoint/policy` and the Layer package. A shell imports the client package (`@adhd/policy-core-client`) only. The client MUST NOT import a shell, apigen, MCP code or process-spawning code; a dependency rule and an architecture test enforce it. Foreign servers and commands are reached by apigen sources (`architect-spec-sources.md`), never by policy code. | (new); owner decisions | S |
| SC-08 | Policy trusts the attributes it is given; authenticity belongs to the supplier. Attributes that a governed process asserts about itself (a flag, file or environment variable it controls) make policy a guardrail, not a security boundary. Enterprise use takes attributes from an auth layer that the governed process cannot modify. | (new) | S |

## 0.1 Variants (VR)

Every variant takes the same inputs and returns the same decisions (SV-04). None requires another, and none requires a running server.

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| VR-01 | Library: import the operation set and evaluate in process. | (new) | S |
| VR-02 | Static gate: `adhd-policy run bin:<command> --spec <file> -- [args]` evaluates one invocation as an operation of the `bin` source (SRC-05) and then runs the command or refuses. A shell alias such as `alias pcurl='adhd-policy run bin:curl --spec standard.yaml --'` gives a policy-gated command that keeps the tool's own interface. | (new) | S |
| VR-03 | `.mcp.json` command wrap: the entry's command becomes `adhd-policy serve <source> --spec <file>` over stdio, where `<source>` is `bin:<original command>` or `remote:<url>`, with an unmodified host and server (SV-14, WM-01). | D4 > File 2 | S |
| VR-04 | Remote upstreams (MCP now; OpenAPI next): the `remote:<url>` source (SRC-02) behind the same `serve`. Upstream credentials come from the auth layer through the invoker's credential seam (SRC-12), never from policy. | (new) | S |
| VR-05 | apigen Layer: a separate package; `apigen serve x.ts --use <auth layer> --use <policy layer> --config <spec>` gates any served operation set. | `architect-spec-layer.md` | S |
| VR-06 | Policy server: the apigen MCP and HTTP projections of the operation set, started only by an explicit command, as a decision service for many callers. | (new) | S |
| VR-07 | Insulation: importing the library, running `run` or `serve` on a source, or loading the Layer MUST NOT start, require or discover a policy server. A server is never mounted automatically. | (new) | S |
| VR-08 | Each variant MUST document which attribute-provision points it supports (LC-08). | (new) | S |
| VR-09 | Wrapper flags in the `--adhd-*` namespace (`--adhd-spec`, `--adhd-attributes`) are recognized anywhere in argv before a bare `--`, consumed, and stripped before the wrapped command sees its arguments. Tokens after a bare `--` pass through unchanged. | (new) | O |

## 0.2 Attribute provision across the lifecycle (LC)

Policy takes one attribute bag per evaluation. Where the bag comes from is the consumer's job.

| Point | Library | Policy server (CLI, MCP, HTTP) | `run bin:` | `serve`, stdio | `serve`, HTTP or remote | apigen Layer |
|---|---|---|---|---|---|---|
| Startup | Caller builds the bag once and reuses it | None; the server holds no identity | `--adhd-attributes` or `ADHD_POLICY_ATTRIBUTES`, read once | `.mcp.json` `env` or args; this is the only identity point of stdio | Server configuration | Host startup configuration |
| Connection or launch | Not applicable | Not applicable | Process start | Process launch | An attribute provider derives them from the connection credential (outside policy) | Not applicable |
| Per request | `attributes` argument of each call | `attributes` input of each operation, filled by an upstream auth layer if present | One request per invocation | Fixed at launch; no per-request identity | Provider maps the verified credential of each request | An earlier `--use` layer writes them to the call envelope |
| Mid-flight | A later call passes a changed bag | Same as per request | Not applicable | `--adhd-attributes @file` is re-read per request | Provider re-derives per request | Same as per request |
| Before response | Not supported in v1 | Not supported in v1 | Not supported in v1 | Not supported in v1 | Not supported in v1 | Not supported in v1 |

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| LC-01 | At startup an attribute source is read once. The sources are the caller's argument, `--adhd-attributes <json or @file>` and `ADHD_POLICY_ATTRIBUTES`. | (new) | O |
| LC-02 | At connection or launch, a transport that has such a point (stdio launch, a 2025-era HTTP session) MAY derive attributes once. The 2026-07-28 MCP revision has no sessions, so identity there is derived per request. | `research-mcp-proxies.md` | U |
| LC-03 | Per request, a consumer passes the bag to `evaluate`. Where a host supports it, per-request attributes come from an attribute provider outside policy. | (new) | S |
| LC-04 | Mid-flight change is the supplier's: a later evaluation passes a different bag. A wrapper reading `--adhd-attributes @file` MUST re-read the file on every request. Policy holds no state between calls. | (new) | O |
| LC-05 | Before-response filtering is not supported in v1: no operation filters or transforms a tool's response (OD-09). | (new) | S |
| LC-06 | When several sources contribute (configuration, credential, request), the consumer merges them into one bag before calling. Policy defines no merge across sources. | (new) | S |
| LC-07 | Every operation that takes attributes treats them as optional (AT-09). | (new) | S |
| LC-08 | Each interface MUST document, in its README, which provision points it supports and what it does at each. | (new) | S |

## 1. Policy documents and discovery (PD)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PD-01 | A tool finds its policy without a `--spec` flag. Resolution order, first match wins: flag, then `workspace-policy.yaml` found by walking up from the working directory to the home directory, then the user-level default file, then a built-in default. | D1 > Policy discovery | S |
| PD-02 | The built-in default policy MUST apply with no flags and no file, and MUST be deny-by-default (PM-07). Its permissions allow only the launch directory for reads and writes, deny sensitive-file and protected-path access, allow network connections only to package registries, and deny metadata addresses. Enforcing these against a process's own behavior is a launcher concern (RS-01). | D1 > Policy discovery | S |
| PD-03 | On startup, every tool MUST print which policy source it used. | D1 > Policy discovery | S |
| PD-04 | The working directory MUST default to the launch directory and need no path argument. | D1 > Policy discovery | S |
| PD-05 | Policy lives in layers: a global user-level file, a project file, and a local user-only file. Layers are discovered by location, not named in configuration. | D4 > Rules > 1; D4 > File 1b | S |
| PD-06 | Permission lists from different layers MUST concatenate. | D3 > Open points | S |
| PD-07 | Attribute-default rules from different layers MUST combine as in LY-01 to LY-04. | D4 > File 1: policy.yaml | S |
| PD-09 | A policy document MUST declare, with a kind (`name`, `names`, `paths`, `number`), every attribute that a `where`, `context`, `$attributes.` placeholder, `set`, `grant` or `only` names. A document that names none declares none (AT-09). | D4 > File 1: policy.yaml (attribute declarations) | S |
| PD-10 | The policy file, the agent configuration and `.mcp.json` MUST NOT be writable by the principals they govern. Policy expresses this as a deny permission; a launcher MAY also enforce it at the kernel (SB-04). | D3 > Gateway guarantees and limits > 8; D4 > File 1 (files.* deny) | S |
| PD-12 | An invalid policy document (unknown variable, undeclared type, malformed filter) MUST refuse to load and name the line. It MUST NOT load partially. | (implied by fail-closed) | U |

## 2. Permission model (PM)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PM-01 | A permission has the keys `tool`, `effect`, `context`, `args`, `set`. All are optional except `tool`. | D4 > Reference vocabulary | S |
| PM-02 | `tool` MUST accept a single name, a list, and a trailing wildcard (`files.*`). Names are `namespace.tool`. | D4 > Reference vocabulary; D4 > File 1 | S |
| PM-03 | A permission applies when the tool matches and both the `context` and `args` filters are true. | D4 > Reference vocabulary | S |
| PM-04 | An omitted filter MUST be treated as true. | D4 > Reference vocabulary | S |
| PM-05 | `effect` MUST default to `allow`. Valid values are `allow`, `ask`, `deny`. | D4 > Reference vocabulary | S |
| PM-06 | When several permissions apply, `deny` beats `ask` beats `allow`. | D4 > Reference vocabulary | S |
| PM-07 | When no permission applies, the call MUST be denied. | D4 > Reference vocabulary | S |
| PM-08 | `set` MUST force the listed argument values into an allowed call before it is forwarded. | D4 > File 1 (shell.shell_execute set) | S |
| PM-09 | A deny from any layer MUST NOT be liftable by a lower layer, an override, or a grant. | D4 > Reference vocabulary | S |
| PM-10 | Permission order within a layer MUST NOT affect the result. | D4 > Reference vocabulary (deny > ask > allow) | S |
| PM-11 | A permission whose `context` does not match the caller's effective attributes and runtime MUST NOT apply. A permission with no `context` MUST apply to every caller. | D4 > File 1 (shared permissions) | S |

## 3. Filters and expressions (FX)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| FX-01 | `context` and `args` filters MUST use the `@adhd/data-query-engine` filter syntax. | D3 > Principles; D4 > Reference vocabulary | S |
| FX-02 | The engine operators in use are `_eq`, `_ne`, `_in`, `_nin`, `_gt`, `_lt`, `_gte`, `_lte`, `_like`, `_ilike`, `_regex`, `_contains`, `_contained_in`, `_is_null`, `_and`, `_or`, `_not`. | D3 > What the query engine provides | S |
| FX-03 | Fields MUST be addressed with full dot notation, including array elements (`command.0`) and nested objects (`child.read_roots`). | D3 > Open points (resolved) | S |
| FX-04 | `$attributes.<name>` placeholders in an `args` filter MUST be substituted from the caller's effective attributes before the engine runs. The engine MUST NOT know about attributes. | D4 > Reference vocabulary | S |
| FX-05 | `context` filters are evaluated over `{ ...attributes, runtime }` directly and need no placeholders. | D4 > Reference vocabulary | S |
| FX-06 | `_within` MUST test that a path (or every element of a list of paths) lies inside one of a list of directories. It is not an existing engine operator. | D4 > Host contract and assumptions > 8 | X |
| FX-07 | Path comparisons MUST resolve real paths (symlinks, `..`, trailing slashes, case rules, macOS `/tmp` to `/private/tmp`) on both sides before comparing. | D4 > Rules > 4 | S |
| FX-08 | Whether several keys in one filter object mean AND SHOULD be confirmed in the engine. Until then, policies use explicit `_and`. | D3 > Open points | U |
| FX-09 | A filter that references an undeclared variable or an unknown operator MUST fail at load time, not at call time. | (implied by PD-12) | U |
| FX-10 | A filter evaluation error at call time (a type mismatch, an operator that fails at run time) MUST result in no match for an allow and a match for a deny. This is the fail-closed direction. An absent attribute is not an error; AT-10 governs it. | (implied by PM-07, FC-01) | U |

## 4. Attributes (AT)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| AT-01 | Attributes are the facts about a caller that a consumer supplies with an evaluation: a flat record of declared names to values. The effective attributes are the supplied attributes plus the values the `defaults` rules derive (LY-01). Policy also reads the read-only `runtime` record (RT-01). | D4 > File 1 (session) | S |
| AT-02 | Attribute kinds are `name`, `names`, `paths`, `number`. The kind defines union, within-check and inheritance behavior. | D4 > Rules > 1 | S |
| AT-03 | No attribute is special. A deployer MAY declare an identity attribute such as `team`, `tier` or `role`; `context` and `where` filters read it like any other. The schema, the engine and every operation MUST NOT assume one exists, and no structure is keyed by it. | D4 > Reference vocabulary | S |
| AT-04 | Supplied attributes are final: `grant`, `only` and `defaults` MUST NOT change them, and a supplied value overrides a default for the same attribute. | D4 > Host contract and assumptions | S |
| AT-05 | A consumer that supplies no attributes gets the empty set. Values for such callers come from `defaults` rules: a rule with no `where` applies to everyone (LY-02), and a rule with `where: { <attribute>: { _is_null: true } }` applies when that attribute is absent (AT-10). | D4 > Rules > 3 | S |
| AT-06 | Policy files carry the rules. Definitions of callers (agent definitions, tokens, profiles) carry attributes only. | D3 > Principles; D4 > File 1 | S |
| AT-07 | An attribute MUST NOT be changeable by a stored policy edit at call time. Only the supplied attributes and the call's `grant` and `only` vary per call. | D4 > Rules > 1 | S |
| AT-08 | Attributes are plain JSON data. Policy neither verifies where they came from nor stores them between calls (SC-08). | (new) | S |
| AT-09 | Attributes are optional everywhere. An operation given none uses the empty set. A policy that declares none compiles and evaluates. A `defaults` rule with no `where` still applies. | (new) | S |
| AT-10 | An absent attribute makes a comparison over it false. A permission whose `context` reads an absent attribute does not apply, whether it allows or denies; a permission with no `context` applies. | (new) | S |
| AT-12 | The policy reference MUST show how to test presence: `{ <attribute>: { _is_null: false } }` matches when the attribute was supplied, and `{ <attribute>: { _is_null: true } }` matches when it is absent. A rule meant to catch unknown callers uses the second form or no `context`. A conformance test pins that `_is_null: true` matches an absent attribute (QE-07). | (new) | U |
| AT-11 | Supplied attributes that the document does not declare are ignored, not an error, so an auth layer can supply a broad bag (OD-28). | (new) | O |

## 5. Runtime values (RT)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| RT-01 | `runtime` is a read-only record of consumer-supplied values (counters, depth, mode) that policy reads. Policy never writes or stores it, and no `grant`, `only` or attribute can set it. | D4 > Reference vocabulary | S |
| RT-02 | A document declares the runtime fields it reads, with kinds (`number` or `name`). The names `depth`, `calls`, `per_hour` and `mode` in the examples are conventions, not reserved. | D4 > Reference vocabulary | S |
| RT-03 | What a count covers (one tool or all tools, a sliding window, children against parents) is defined by the runtime provider (OD-07). | D4 > Reference vocabulary | O |
| RT-07 | A limit shared across processes needs a provider that records and reads atomically; a read-then-write provider cannot enforce it. Policy ships no provider implementation. | AGENTS.md parallel-process rule | S |
| RT-08 | The service layer takes an optional `IRuntimeProvider` (port). With one, `evaluate` calls `observe` once per call, which records the call and returns the post-observation values atomically; the decision uses them. A denied call still counts as an attempt. | (new) | O |
| RT-09 | If a permission reads `runtime` and no provider or value is supplied, evaluation denies with code `runtime-unavailable`, and `verify` warns for each permission that reads `runtime`. | (new) | S |

## 6. Layers and defaults (LY)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| LY-01 | An attribute's default comes from the `defaults` rules whose `where` matches the supplied attributes, taken in layer order (global, then project, then local) and file order within a layer. For each attribute the last matching rule that sets it wins. | D4 > Rules > 1 | S |
| LY-02 | A `defaults` rule with no `where` MUST apply to every caller. | D4 > File 1 (comment) | S |
| LY-03 | A variable no matching rule sets is "not specified" and is inherited under MG-01. | D4 > Rules > 1 | S |
| LY-04 | A rule MUST be able to set an explicit empty value (`write_roots: []`) to stop inheriting. | D4 > Rules > 1 | S |
| LY-05 | A project layer MUST NOT introduce an absolute path. Global and local layers MAY. | D4 > Rules > 4 | S |
| LY-06 | A local user layer MUST store "allow always" answers. Agents MUST NOT be able to edit it. | D4 > Trace; D3 > ask | S |
| LY-07 | `where` MUST be matched against the supplied attributes only, never against values other rules set, so rule order cannot create a dependency between rules. It uses the same filter syntax as `context` and MAY name only declared, non-runtime attributes. | (new) | S |
| LY-08 | `compile` MUST reject a `defaults` rule whose `set` names an undeclared variable or a value of the wrong kind, and MUST apply AP-07 to its values. | CL-04, AP-07 | S |

## 7. Merging a child's attributes (MG)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| MG-01 | If the child does not specify a variable and the call's `grant` does not set it, the child inherits the parent's value. | D4 > Rules > 1 (table) | S |
| MG-02 | If the child does not specify it and `grant` sets it, the child gets the `grant` value. | D4 > Rules > 1 (table) | S |
| MG-03 | If the child specifies it and `grant` does not, the child keeps its own value. | D4 > Rules > 1 (table) | S |
| MG-04 | If the child specifies it and `grant` sets it, the result is the union. For `paths` and `names` that is a set union; for `number` it is the larger value. | D4 > Rules > 1 (table) | S |
| MG-05 | After the add step, `only`, if present for that variable, MUST lie within the add step's result and replaces it. | D4 > Rules > 1; D4 > Trace (second dispatch) | S |
| MG-06 | `grant` and `only` MAY name the same variable. `grant` is applied first. | D4 > Host contract and assumptions > 3 | O |
| MG-07 | An `only` value outside the add step's result MUST cause the narrowing to be denied. | D4 > Rules > 1; D4 > Trace (second dispatch) | S |
| MG-08 | The final result (the completed child attributes, `child.*`) MUST lie within the parent's attributes. | D4 > Rules > 1 | S |
| MG-09 | If the completed child attributes exceed the parent's, the narrowing MUST be denied. Clamping to the intersection is not performed. | D4 > Host contract and assumptions > 2 | O |
| MG-10 | The merge MUST be a pure function of (child defaults, parent attributes, `grant`, `only`) so it can be property-tested. | (implied by PS-03) | S |
| MG-11 | The parent MUST NOT be able to restrict an attribute below what `only` allows, and MUST NOT be able to raise the child above the parent's own attributes. | D4 > Rules > 1 | S |

## 8. Narrowing and authority (NR)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| NR-01 | A child's authority MUST be a subset of its parent's at every level. | D4 > Rules > 1 | S |
| NR-02 | The narrowing check MUST be written once and cover every tool the policy declares as child-creating. | D4 > File 1 (narrowing) | S |
| NR-03 | The narrowing check MUST compare each completed variable, using the type's comparison: `paths` inside, `names` a subset, `number` at most. | D4 > File 1 (narrowing) | S |
| NR-04 | `narrow` MUST deny any key in `grant` or `only` that no narrowing check covers. | D4 > Rules > 5; D4 > Trace | S |
| NR-05 | A depth limit MUST be expressible: a permission can deny child creation by a `runtime` depth value the provider supplies. | D4 > File 1 (depth deny) | S |
| NR-06 | Narrowing checks MUST be evaluated by the consumer in a process the child does not control. | D4 > Reference vocabulary (principles) | S |
| NR-07 | The policy library MUST offer no operation that returns attributes wider than the parent's. A child's authority widens only through a new `narrow` call evaluated against its parent. | D4 > Rules > 2 | S |

## 9. Absolute and shared paths (AP)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| AP-01 | Shared folders MUST be separate attributes (`shared_read_roots`, `shared_write_roots`) so a rule's own `read_roots` does not replace them. | D4 > File 1; D4 > File 1b | S |
| AP-02 | Shared roots are set in the global layer and inherited by every child through MG-01. | D4 > File 1b | S |
| AP-03 | A permission with no `context` filter MUST grant shared-folder access to every caller. | D4 > File 1 (shared permissions) | S |
| AP-04 | Shared roots reach a launcher or sandbox only through the effective attributes (RS-01, RS-02). Policy defines no routing to processes. | D4 > File 1 (handoff, now consumer-owned) | S |
| AP-05 | The deny entry for secrets and protected paths MUST still apply inside shared folders. | D4 > File 1b; D4 > Trace | S |
| AP-06 | A matching rule MAY drop shared roots with an explicit empty list, and a parent MAY restrict them with `only`. | D4 > Host contract and assumptions > 12 | O |
| AP-07 | A `grant` or `only` containing an absolute path MUST be accepted only if it lies within the parent's attributes. | D4 > Rules > 4 | S |
| AP-08 | Shared write folders are shared state across principals; the system MUST NOT claim isolation between principals that share one. | D4 > Host contract and assumptions > 11 | S |

## 10. Launch scope and residual constraints (RS)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| RS-01 | Policy defines no routing from attributes to processes: no destination table, no sandbox, `argv`, `env` or `cwd` mapping. A launcher or sandbox reads the effective attributes and applies its own configuration. | (new); owner direction | S |
| RS-02 | Effective attributes are available through `resolve` (CL-10), so a consumer derives launch scope without re-implementing `defaults`. | (new) | S |
| RS-03 | A pure `residual(policy, { tool, attributes })` query could return, per matching allow permission, its `args` filter with attribute placeholders substituted and the call arguments left unbound. A launcher, or apigen inference over typed parameters, would turn that into a launch-time scope. It is proposed and not built (OD-21). | (new) | O |
| RS-04 | A consumer that derives launch scope SHOULD derive it from the same attribute the `args` filters use, so the two cannot disagree. | D4 > File 1 (files permissions) | S |
| RS-05 | A server that needs an attribute to filter its own behavior receives nothing from policy. Such filtering happens at the enforcement point through `evaluate`. | D4 > Host contract and assumptions > 7 | S |

## 11. Delegation and authenticity (DL)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| DL-01 | `narrow` is pure. It returns child attributes or a denial naming the attribute and rule. It issues no reference, token or identifier and stores nothing. | D4 > Rules > 1 | S |
| DL-02 | How a child receives its attributes (environment, header, signed token, reference to a store) belongs to the consumer and the auth layer. Policy accepts attributes only as data (SC-08). | (new) | S |
| DL-03 | A consumer that hands child attributes over a channel the child can forge gets no containment from policy. Forgery resistance (signed assertions, a reference store, lifetimes) is an auth-layer or consumer feature. | (new) | S |
| DL-04 | A consumer MAY recompute child attributes by calling `narrow` itself in a process the child does not control (NR-06). | (new) | S |

## 12. Explainability (EX)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| EX-01 | A user MUST be able to ask for the effective attributes of a supplied set (the defaults that match it and the permissions that can apply) and see where each value came from (supplied, layer default, `grant` or `only`). | D3 > explain | S |
| EX-02 | The explanation of a decision MUST name the matched permission and the filters that were evaluated. | D3 > explain; D4 > Trace | S |
| EX-03 | A consumer MAY annotate explanations with where a rule is enforced (enforcement point, kernel or both). Policy reports only evaluation. | D3 > explain | O |
| EX-04 | A dispatch denial MUST name the variable and the rule that failed. | D4 > Trace (rejections) | S |
| EX-05 | The explanation of a multi-level chain MUST list each hop with its attributes and enforcer. | (discussed, not in a demo) | O |

## 13. Audit and observability (AU)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| AU-01 | The consumer's `IAuditSink` receives a structured, redacted record of each decision: tool, effect, matched permission and the attribute names (values only when configured). With no sink supplied, nothing is written. | D1 > Variant B (audit) | S |
| AU-02 | Each narrowing's completed child attributes MUST be available to the consumer for recording against its task. | D4 > Rules > 1 | O |

## 14. Failure behavior (FC)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| FC-01 | Any condition the client cannot evaluate MUST result in deny. | D4 > Reference vocabulary (no match is deny) | S |
| FC-04 | An unanswerable `ask` MUST deny. | D3 > ask | S |
| FC-05 | A `grant` or `only` key with no narrowing check MUST deny. | D4 > Rules > 5 | S |
| FC-06 | A policy that fails to load MUST stop the tool, not start it with a weaker policy. | (implied by PD-12) | U |

## 15. Security invariants (SI)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SI-01 | Authority MUST only be granted by an enforcer the grantee cannot modify. | D4 > Rules > 2; (nested-sandbox discussion) | S |
| SI-02 | There MUST be no operation that edits a policy file or a caller's attributes. | D1 > Common | S |
| SI-03 | A child MUST NOT exceed its parent on any attribute, at any depth. | D4 > Rules > 1 | S |
| SI-04 | Caller definitions (agent definitions, tokens, profiles) MUST carry no rules, so editing a definition cannot widen authority. | D4 > File 1 (defaults) | S |
| SI-05 | Policy MUST NOT treat attributes as authenticated: authority is bounded by the supplier (SC-08, DL-03). | (new) | S |
| SI-06 | Policy defines no channel that gives attribute values to a process (RS-01). | (new) | S |
| SI-07 | Inheriting an attribute MUST NOT silently give a principal scope it should not have; a rule for principals that must not inherit specifies an explicit empty value. | D4 > Rules > 1; D4 > File 1 (defaults) | S |

## 16. Platform and compatibility (PL)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PL-01 | macOS and Linux MUST be supported at first release. Windows MUST be documented as unsupported. | D1 > Common | S |
| PL-04 | `adhd-policy serve` MUST work with any MCP-capable host that launches servers from `.mcp.json`. | D1 > Scenario; D4 > File 2 | S |
| PL-05 | Server, tool and argument names in the examples are unverified. Real bindings MUST be written from each server's schema. | D3, D4 > Caveats | U |

## 17. Non-goals (NG)

| ID | Statement | Demo reference |
|---|---|---|
| NG-02 | The system does not isolate untrusted code from strangers. A VM or container is still needed. | D1 > Common |
| NG-03 | The system does not narrow unstructured arguments. | D3 > Gateway limits > 4 |
| NG-05 | The system does not replace scoped tokens or RBAC. | D2 > Caveats |
| NG-07 | The system does not provide a host UI. Approval prompts come from the host. | (discussion) |
| NG-08 | The policy library does not authenticate callers, own or store sessions, confine processes, or store or inject credentials (SC-03). | (new) |

## 18. Proof suite (PS)

Each item is a default-running test through a real MCP host, with a negative control that turns it red when the protected logic is removed.

| ID | Test | Behaviors covered | Negative control |
|---|---|---|---|
| PS-02 | Every allow, deny and ask decision in the D4 trace is reproduced by the evaluator. | PM-01 to PM-11, FX-01 to FX-05, TL-01 to TL-11 | Break `deny beats allow` |
| PS-03 | Property tests over random attribute sets: inherit, union, `only` and the within-parent rule hold; the child never exceeds the parent. | MG-01 to MG-11, NR-01, SI-03 | Remove the within-parent check |
| PS-09 | Shared folders are readable and writable by all agents, and the secret deny still applies inside them. | AP-01 to AP-05 | Remove the deny entry |
| PS-10 | A caller whose attributes match a rule with an explicit empty list does not inherit the parent's value. | LY-04, SI-07 | Make explicit empties inherit |
| PS-11 | An unknown `grant` key is denied. | NR-04, FC-05 | Allow unknown keys |
| PS-12 | Policy, agent and server configuration files cannot be written by a governed agent. | PD-10, SI-02 | Remove the deny entry |
| PS-16 | `compile` is deterministic, and `evaluate` over the compiled JSON equals `evaluate` over a fresh compile for random calls. | CL-05, CL-06, CC-03 | Corrupt the compiled output |
| PS-17 | Edit a layer file: the next load recompiles. Two concurrent loads in one process return equal policies. | CC-02, CC-05, CC-08 | Ignore the hash |
| PS-18 | Engine conformance cases (implicit AND, dot notation, coercion) fail when the engine behavior changes. | QE-07 | Swap the engine operator |
| PS-20 | Environment variables cannot widen a permission. | EV-03 | Let a variable add an allow |
| PS-22 | Compile and evaluate with no attributes, no runtime provider and no server: decisions follow AT-09 and AT-10. A permission using `_is_null` presence checks behaves as AT-12 describes. | SC-05, AT-09, AT-10, AT-12 | Require attributes |
| PS-23 | Loading the library root in a clean process opens no listener, spawns no process and loads no shell, apigen or MCP code. | SC-06, SC-07, CL-12 | Start a server at import |
| PS-24 | A permission that reads `runtime` with no provider denies with `runtime-unavailable`, and `verify` warns. | RT-09 | Treat missing runtime as zero |

## 19. Open decisions (OD)

| ID | Decision | Current default | Affects |
|---|---|---|---|
| OD-01 | Clamp completed child attributes to the parent's intersection, or deny. | Deny | MG-09 |
| OD-05 | Whether shared roots are removable by a rule. | Removable | AP-06 |
| OD-06 | Whether `grant` and `only` may name the same attribute. | Allowed, `grant` first | MG-06 |
| OD-07 | Whether `runtime` counts cover one tool or all tools, and how child calls count against the parent. | Defined by the runtime provider | RT-03 |
| OD-09 | Response filtering. | Not provided | NG-01 |
| OD-10 | How a child's ask reaches its parent. | Host only | AK-06 |
| OD-11 | Whether the monotone compile property is enforced at load time or only tested. | Tested | SB-05 |
| OD-12 | Who owns the engine extension `_within`. | Engine package | FX-06, QE-04 |
| OD-15 | Package and binary names (BO-05): `@adhd/policy-core-client`, `entrypoint/policy` with bin `adhd-policy`. | As listed in BO-05 | BO-05 |
| OD-16 | How `check` reports `ask`. apigen has no approval code (`CLI_EXIT_CODE`: `invalid_argument` 2, `unauthenticated` 3, `permission_denied` 3, `not_found` 4, `internal` 1; MCP has the single kind `error`). The owner leans toward an apigen-level approval-required result for CLI and MCP, possibly HTTP, after an audit of every host, base error type and custom error mapping (backlog item). | Interim: `check` collapses `ask` to `permission_denied` (fail closed); target: an apigen approval code | IN-09, SV-08 |
| OD-17 | Name and placement of the apigen policy Layer plugin package. | `packages/apigen/apigen-plugin-policy`, `@adhd/apigen-plugin-policy` | LP-01, BO-06 |
| OD-19 | Whether attribute merge and narrowing value operations (union, within-parent, assign) move into `@adhd/data-query-engine` as update operators. | Stay in `core/attributes` | QE-09, MG-* |
| OD-20 | Decision speed for many callers: bind attributes as parameters and evaluate calls in batches on the engine's plan cache (QE-10), or memoize decisions that do not read `runtime`. | Substitute before the engine; compiled-policy memo only | QE-10, CC-01 |
| OD-21 | How a launcher or sandbox gets launch scope: its own configuration over `resolve` output, or a pure `residual` query (partial evaluation, RS-03). | Launcher-owned configuration; `residual` proposed, not built | RS-01, RS-03 |
| OD-28 | Supplied attributes the document does not declare. | Ignored, not an error (AT-11) | AT-11 |
| OD-31 | Protocols supported by the `remote` source in v1. | MCP and OpenAPI; GraphQL and gRPC later (SRC-02, SRC-13) | SRC-02 |
| OD-32 | Where `remote` and `bin` source support lands in apigen: new plugin packages or existing `apigen-core-client` / `apigen-engine-gateway` (a placeholder). | Undecided; new packages need approval | SRC-01 |
| OD-33 | Refresh policy for an extracted remote IR: startup only, TTL, or change notification (`list_changed`, etag). | Startup plus change notification where the protocol provides one (SRC-10) | SRC-10 |

## 20. Query-engine evaluation (QE)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| QE-01 | All `args` and `context` expressions MUST be evaluated by `@adhd/data-query-engine` (`packages/data/data-query-engine`). The policy package MUST NOT implement its own operator set. | D3 > What the query engine provides; D4 > Reference vocabulary | S |
| QE-02 | The accepted operators MUST be exactly the engine's operators (`_eq`, `_in`, `_lte`, `_like`, `_regex`, `_contained_in`, `_not`, `_and`, `_or`, and the rest it ships) plus the extensions in QE-04. | D3 | S |
| QE-03 | `$attributes.*` and `$tool.*` placeholders MUST be substituted by the policy layer before the engine runs. The engine MUST stay unaware of attributes. | D3; D4 > Reference vocabulary | S |
| QE-04 | An operator the engine lacks (`_within`) MUST be contributed to the engine package as a general operator, or implemented in the policy layer as a pre-engine rewrite into engine operators. The policy package MUST NOT fork the engine. | D4 > Reference vocabulary | O |
| QE-05 | `compile` MUST reject any expression using an operator, field syntax or placeholder the engine or substitution step cannot evaluate. | (new) | S |
| QE-06 | Evaluation MUST use the engine's public exports only. | (new) | S |
| QE-07 | Engine behavior the spec relies on (implicit AND across keys, full dot notation including `command.0`, type coercion of strings vs numbers) MUST be pinned by conformance tests in the policy package, so an engine change that breaks a permission fails a test. | (new); D4 > Caveats | U |
| QE-08 | Evaluation MUST be pure and synchronous over plain data: the same compiled policy, call, attributes and runtime values always give the same decision. | (new) | S |
| QE-09 | The query engine has no value-level update operator today (its `insert`, `append` and `remove` ingest rows into a view). Union, within-parent and assignment for attribute values therefore live in the policy core (`core/attributes`). If the engine later gains such operators, the core MAY delegate to them (OD-19). | (new) | S |
| QE-10 | Binding attribute values as parameters, instead of substituting them into the filter text, would let one compiled filter plan serve many callers and batches. This needs parameter binding in the engine, which is unverified (OD-20). | (new) | U |

## 21. Client API: compile and evaluate (CL)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| CL-01 | The client MUST export `compile(policyJson)` returning a `CompiledPolicy`. | (new) | S |
| CL-02 | The client MUST export `evaluate(policy, call, attributes?, runtime?)` returning a `Decision`. `policy` is a `CompiledPolicy`. `call` is `{ tool, args }`. `attributes` are the caller's supplied attributes (optional, AT-09). `runtime` is the provider-supplied record (optional, RT-01). | (new); D4 > Reference vocabulary | S |
| CL-03 | `compile` input is plain JSON (the YAML files in the demos are parsed to JSON before compile). | (new) | S |
| CL-04 | `compile` MUST validate shape, layer merge inputs, `defaults`, attribute and runtime declarations, `grant`/`only` coverage (PM and NR rules) and expression support (QE-05), returning errors with a JSON path for each failure. | D4 > Rules > 5 | S |
| CL-05 | `compile` MUST be deterministic and side-effect free. Equal input gives byte-equal output. | (new) | S |
| CL-06 | `CompiledPolicy` MUST be JSON-serializable, carry a schema version and a content hash, and be loadable without recompiling. | (new) | S |
| CL-07 | `Decision` MUST contain `effect` (`allow`, `ask`, `deny`), `set` (forced argument values), the matched permission identifiers, and a reason for deny. | D3 > explain | S |
| CL-08 | `evaluate` MUST apply resolution order deny > ask > allow, and no match is deny. | D4 > Reference vocabulary | S |
| CL-09 | The client MUST export `narrow(policy, parent, { grant, only, attributes })` returning the child attributes or a denial naming the attribute and rule. It is pure: it issues no reference and stores nothing (DL-01). | D4 > Rules > 1 | S |
| CL-10 | The client MUST export `resolve(policy, attributes?)` returning the effective attributes and, for each value, where it came from (supplied or layer default). | RS-02 | S |
| CL-14 | A `draft` operation MUST take a plain-data view of a foreign source's operations and return a draft policy document plus the list of inferred values (SRC-11). It imports no apigen type. | SRC-11 | O |
| CL-11 | The client MUST export `explain(policy, call, attributes?, runtime?)` returning the evaluated filters and their results. | EX-01, EX-02 | S |
| CL-12 | Importing the client (the package root) MUST load no MCP SDK, apigen, sandbox or agent-runtime code and start nothing (SC-06). It is usable by any host. | PL-04; SC-02 | S |
| CL-13 | An unknown schema version, a hash mismatch or a malformed compiled policy MUST make load fail. It MUST NOT fall back to an older or weaker policy. | FC-06 | S |

## 22. Compiled policy memo (CC)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| CC-01 | The compiled policy MAY be memoized in process memory, keyed by the content hash of every input layer (global, project, local) and the compiler version. | (new) | S |
| CC-02 | A memo entry is valid only if its hash matches the current inputs. A mismatch MUST recompile. | (new) | S |
| CC-03 | A memo hit MUST NOT parse YAML, run the compiler or walk the layers. | (new) | S |
| CC-04 | There is no disk cache. A deployer who wants a precompiled artifact produces one with `compile`. `loadCompiled` is internal to the client and is not exported from the package root; the client loads the artifact with it (CL-06, CL-13). | (new) | S |
| CC-05 | Memo entries are immutable, so concurrent evaluations in one process are safe. There is no shared mutable state between processes. | AGENTS.md parallel-process rule | S |
| CC-08 | A change to any layer file MUST take effect on the next load. | (new) | S |

## 23. Configuration through @adhd/environment (EV)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| EV-01 | Policy location, layering and runtime settings MUST be resolved by `@adhd/environment` (`Environment`) using its cascade: code defaults, system, global, project, then environment variables. | (new); AGENTS.md Environment Cascade | S |
| EV-02 | The global, project and local policy layers (LY-01 to LY-06) MUST map onto the environment cascade's global and project levels. The runtime level MUST carry per-process overrides such as the log directory. | LY-01 to LY-06 | S |
| EV-03 | Policy content (permissions and attribute defaults) is data in layer files. Environment variables MUST NOT be able to add or widen permissions. They MAY only locate files and set operational settings. | (new); SI-02 | S |
| EV-04 | The log directory and violation log MUST be resolved through the environment package. | AU-01 | S |
| EV-05 | The wrapper MAY read initial attributes from `ADHD_POLICY_ATTRIBUTES` (a JSON object or `@file`). This is data supplied by the launcher, not a setting that changes policy, and it is self-asserted when the governed process controls its environment (SC-08). | LC-01 | O |
| EV-06 | The client and every entrypoint MUST work with zero configuration: if no layer exists the built-in default applies. | PD-04 | S |
| EV-07 | The policy package MUST declare its settings in the environment package's schema so `environment-cli` lists them with source and value. | (new) | U |
| EV-08 | Settings that name the trust anchor (policy file paths) MUST be resolved from layers an agent cannot write (SI-01). | PD-10 | S |

## 24. Build order and approvals (BO)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| BO-01 | Order: client package first, then the wrapper: `core`, then `service` and the operation set, then the CLI, MCP and HTTP entry files (apigen), then docs. The gateway, the sandbox and host integrations are separate consumers that follow. | (new) | S |
| BO-02 | Creating the two packages requires explicit human approval recorded in the ticket, per repo rules: `packages/policy/policy-core-client` (library; needs the new domain `policy` added to `.adhd/workspace.json` first) and `entrypoint/policy` (apigen wrapper and shells). Nothing in this document is that approval. | AGENTS.md package-creation rule | S |
| BO-03 | The client MUST be scaffolded with the `core` generator (`--group policy --name client`, dry-run first) and the wrapper with the `entrypoint` generator. | AGENTS.md section 1 | S |
| BO-04 | Dependencies flow `entrypoint/policy` to `@adhd/policy-core-client`, never back. Inside the client, layers flow downward (spec, core, service); `core` may import only the spec and `data-query-engine`. A lint rule and an architecture test enforce both. | AGENTS.md section 2 | S |
| BO-05 | Names: library `@adhd/policy-core-client` (`packages/policy/policy-core-client`); wrapper `entrypoint/policy` with the bin `adhd-policy` (apigen verbs plus hand-written `exec` and `mcp` verbs in one bin, feasibility IF-11). Both pending approval. | owner direction | O |
| BO-06 | Creating the apigen policy Layer plugin package requires its own explicit human approval recorded in the ticket. It is scaffolded with the `plugin` generator (`--group apigen --nxLayer logic --platform node`), dry-run first. | AGENTS.md package-creation rule | S |

## 25. Entrypoints and operation surface (SV)

The client package ships the programmatic API. The wrapper package ships three apigen projections of it plus the `run`, `serve` and `mcp-json` verbs over apigen sources. The CLI, MCP server and HTTP server are generated by apigen from the client's operations and contain no behavior of their own; the source verbs contain no policy logic (SV-15). Nothing starts unless explicitly commanded (VR-07).

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SV-01 | The client package MUST provide the programmatic API (compile, verify, resolve, narrow, evaluate, check, explain, show, draft, doctor). The wrapper package `entrypoint/policy` MUST provide the apigen CLI, MCP server and HTTP server over those operations, and the `run` and `serve` verbs over apigen sources, with the policy Layer loaded. No server starts unless explicitly commanded (VR-07). | (new) | S |
| SV-02 | The client's operation set is the exported functions of one file (`api.ts`). Every entrypoint exposes exactly that set. | apigen Tenet 0 | S |
| SV-03 | The CLI, MCP and HTTP entry files (everything except the `mcp-json` verb) MUST contain no operation, parsing, validation, help text, exit-code mapping, route, tool schema or authorization code. They select an apigen target plugin and pass configuration only. | apigen Tenet 1 | S |
| SV-04 | For the same operation and input, the programmatic client, CLI, MCP and HTTP MUST return the same result (up to the transport envelope). A parity test proves it. | (new) | S |
| SV-05 | Operations MUST take and return JSON-serializable values only. Attributes and runtime values are passed by value. | (new) | S |
| SV-06 | The operation set MUST include: `compile`, `verify`, `evaluate`, `check`, `explain`, `show`, `resolve`, `narrow`, `doctor`. | `architect-interfaces.md` section 5 | S |
| SV-07 | `evaluate` MUST accept optional `attributes`. When the service layer is given an `IRuntimeProvider` it MUST observe through it (RT-08); without one it is a pure function of its inputs. | RT-01 to RT-09 | S |
| SV-08 | `check` MUST return an error mapped to apigen's `permission_denied` (exit code 3) when the decision is `deny`. Until apigen has an approval-required result (OD-16), `check` maps `ask` to `permission_denied` as well, with the reason naming `ask`. | IN-09 | O |
| SV-09 | The package holds no state except the in-memory compiled-policy memo (CC-01). Runtime counters, audit records and attribute storage live in consumer-supplied ports (SC-03). | CC-05, SC-03 | S |
| SV-10 | MCP defaults to stdio; HTTP defaults to loopback. A non-loopback bind MUST be explicit configuration. Authentication and rate limits are deployment configuration (apigen layers via out-of-source options), never code in the entry files. | apigen Tenet 1 | S |
| SV-11 | Every entrypoint exposes `show` and `explain`, so a deployer who exposes MCP or HTTP to governed processes reveals the policy to them. The documentation MUST say so, and a deployer MAY restrict the exposed set by apigen include/exclude selection. | apigen SPEC section 3 | S |
| SV-12 | The CLI's per-invocation cost for `check` MUST be measured, always, through the tracing plugin (IN-15). If apigen startup makes it unacceptable for hook use, the programmatic client or the long-running MCP/HTTP server is the fast path; adding a hand-written fast command is not allowed. A disk cache is added only if the measurement shows it is needed. | (new) | S |
| SV-13 | Importing the package root loads only the client; no entry file, apigen, ts-morph, the MCP SDK or server code is loaded. | CL-12 | S |
| SV-14 | `.mcp.json` wrapping MUST work through apigen sources: replacing a server entry's `command`/`args` with `adhd-policy serve <source> --spec <file>` (WM-01) makes the unmodified host and server run under policy. Policy contains no proxy code; the source and the host are apigen's. | D4 > File 2; `architect-spec-sources.md` | S |
| SV-15 | Entry files MUST contain no policy logic: every decision, narrowing and attribute resolution comes from the client's operations (GW-17). Architecture tests enforce that an entry file imports the client only through the operation module. | GW-17 | S |
| SV-16 | The client MUST have exactly one importable path, its root. The `exports` map lists the root and `package.json` and closes every other path. `spec`, `core` and `service` are folders separated by lint and architecture tests (BO-04), not by import paths. | (new) | S |
| SV-17 | The client has no apigen, MCP or server dependency. The wrapper's apigen packages are regular dependencies of `entrypoint/policy`, so every bin works after a plain install. A client-only consumer pays none of that weight. | (new) | S |
| SV-18 | The root exports a decider factory (`createDecider`) that satisfies the Layer plugin's port structurally. The plugin is a separate package; neither imports the other, and only test code in this package may import the plugin (LP-02, LP-03, LP-05). | `architect-spec-layer.md` | S |
| SV-20 | A `bin` source with no extractable interface MUST fall back to one operation `{ argv: string[], cwd }` named for the command (SRC-05). On `allow` the command runs with the original argv, stdio, environment and exit code unchanged. On `deny`, or on `ask` with no answering channel, it refuses with a non-zero exit and writes the reason to stderr. It starts no server. | (new) | O |
| SV-21 | For the argv fallback, what `set` means (replace `cwd`, add or replace argv elements) is open. An extracted `bin` interface (typed flags) makes `set` an ordinary argument override. | (new) | O |
| SV-22 | The wrapper takes attributes per LC-01 to LC-04 and strips `--adhd-*` flags before the wrapped command sees argv (VR-09). | (new) | S |

## 26. Integration: environment, query engine, apigen (IN)

Detail and interfaces: `architect-interfaces.md` section 10.

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| IN-01 | `@adhd/data-query-engine` MUST be imported only from the client's engine adapter files. No other layer may import it. | QE-01, QE-06 | S |
| IN-02 | `@adhd/environment` (with `@adhd/environment-base-spec` types) MUST be imported only from the `service` layer's config files; resolved values are passed to `core` as arguments. | EV-01 | S |
| IN-03 | The environment spec MUST be code-defined (`EnvironmentSpec`), declare an env prefix, and give every setting a type, an environment variable, a default and a description, so the package works with zero configuration. | EV-06, EV-07 | S |
| IN-04 | The environment cascade MUST map as: code defaults, system, global (user layer file, logs), project (project layer, local layer), environment variables (operational settings, the attribute source of EV-05). | EV-02 | S |
| IN-05 | The package MUST define a non-default `test` namespace so its tests never read or write the user's real cache or logs. | AGENTS.md test-artifact rules | S |
| IN-06 | The CLI, MCP and HTTP entrypoints MUST be apigen projections of one operation set (the client's `api.ts`): plain exported functions with serializable parameters, with no hand-written parsing, validation, help, exit codes, routes or tool schemas. | apigen Tenet 0 | S |
| IN-07 | No operation MAY write a policy layer file, and no operation MAY accept a path to be written, so exposing every operation on MCP or HTTP cannot let a caller change policy. | SI-02, PS-12 | S |
| IN-09 | `check` MUST exit non-zero on `deny` using apigen's `permission_denied` exit code (3). Until apigen has an approval-required result (OD-16), `ask` exits the same way. | CL-08 | O |
| IN-10 | A malformed tool call MUST be rejected as `invalid_argument` by apigen's validate layer before the function runs. `set` values MUST be applied before validation so forced values are also validated. | PM-05, GW-05 | S |
| IN-12 | Importing the package root MUST NOT load apigen, ts-morph or any MCP or HTTP server code; a test loads the root in a clean process and inspects the loaded modules. | CL-12 | S |
| IN-13 | For source files, the apigen IR MUST be baked at build (`dist/api.ir.json`) so a run does no source extraction. For `remote` and `bin` sources the IR is extracted at startup and refreshed per SRC-10. A runtime IR cache, if used, MUST take its directory from the environment, never from the working directory. | EV-04 | S |
| IN-14 | Context construction for operations (policy, runtime provider, audit sink) MUST be lazy, so `--help`, unknown commands and invalid arguments load nothing. | (apigen lazy-ctx precedent) | S |
| IN-15 | The CLI, MCP and HTTP entry files MUST mount `apigen-plugin-tracing` on every operation, so evaluation latency and CLI startup are always measured. | AU-01, SV-12 | S |
| IN-16 | Architecture tests MUST fail the build if a layer imports an integration outside its home (IN-01, IN-02, apigen only from the entry files). | BO-04 | S |
| IN-17 | `policy doctor` MUST print each resolved setting with the cascade level it came from. | EV-07 | S |

## Coverage map: demo sections to behavior IDs

IDs with prefixes GW, AK, SB, SX, SP, DP, TL, PG, LP are in the companion files.

| Demo section | IDs |
|---|---|
| D1 > Policy discovery | PD-01 to PD-04 |
| D1 > Variants A to D, Common | SB-01, SB-09, SB-10, SB-11, PL-01, PL-02, NG-02, NG-06 |
| D3 > How a call is evaluated, Gateway limits | GW-01 to GW-16, NG-01, NG-03, NG-04 |
| D3 > ask, explain | AK-01 to AK-04, EX-01, EX-02 |
| D4 > Reference vocabulary | PM-01 to PM-11, FX-01 to FX-05, RT-01 to RT-03, AT-01 to AT-03 |
| D4 > How session variables reach execution | RS-01 to RS-05 |
| D4 > Rules 1 to 5 | MG-01 to MG-11, NR-01 to NR-07, DL-01 to DL-04, AT-05, AT-12, LY-01 to LY-06, AP-07, FX-07 |
| D4 > File 1: policy.yaml | PM-*, TL-01 to TL-11, NR-02 to NR-05, DP-01, DP-02, RS-*, PD-09 |
| D4 > File 1b | AP-01 to AP-05, LY-05 |
| D4 > File 2 | DP-04, DP-07, GW-03, PD-11 |
| D4 > Trace | DP-08, EX-04, TL-* |
| D4 > Host contract and assumptions | DL-03, DP-06, OD-* |
| New requirements (not in a demo) | SC-*, VR-*, LC-*, AT-08 to AT-11, RT-07 to RT-09, QE-*, CL-*, CC-*, EV-*, SP-*, PG-*, BO-*, IN-* |
