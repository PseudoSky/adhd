# Architect spec: the apigen policy Layer plugin

Status: draft for owner review. Behaviors only; creates no package, installs nothing. Companion to `architect-spec.md` (the policy package, `@adhd/policy`) and `architect-interfaces-layer.md`. Format, status codes and keywords: see `architect-spec.md`.

The plugin is a separate package (working name `@adhd/apigen-plugin-policy`) that adds one apigen `layer` capability. Loaded with `--use`, it makes any apigen-served operation set (CLI, MCP, HTTP, gRPC) ask a policy decider before each call runs. It is a sibling of the other apigen plugins (logger, health, tracing). It does not contain the policy engine and does not import `@adhd/policy`, so the dependency graph has no cycle.

## 1. Package and dependency direction (LP)

| ID | Behavior | Reference | Status |
|---|---|---|---|
| LP-01 | The plugin MUST be its own package, separate from `@adhd/policy`. It MUST declare exactly one apigen capability, `layer`, plus the request-envelope reading of attributes (LP-09). It declares no target and no mount. | apigen SPEC section 7.1 | S |
| LP-02 | The plugin MUST NOT import `@adhd/policy` or any package that depends on it. `@adhd/policy` source MUST NOT import the plugin. Only test code in `entrypoint/policy` may import the plugin (as a dev dependency), so the package graph is `entrypoint/policy (tests) -> plugin` and never the reverse. Architecture tests on both sides fail the build on a violation. | repo dependency flow rule | S |
| LP-03 | The contract between the two is a structural port, `IPolicyDecider`, defined in the plugin. `@adhd/policy` exports a function that returns an object satisfying that port without importing its type. A contract test in `entrypoint/policy` imports both and fails if the shapes drift. | LP-02 | S |
| LP-04 | The decider MUST be supplied either as an object (programmatic use) or as a module specifier or path in the plugin's `--use` options, loaded the same way apigen loads `--use` plugins. The module exports `createDecider(options)`. The plugin MUST NOT assume which package supplies it. | apigen SPEC section 7 (`--use` accepts a specifier or a path) | S |
| LP-05 | `@adhd/policy`'s own CLI, MCP and HTTP entrypoints MUST NOT load the plugin. Policy administration operations are not gated by the policy they administer, and the self-reference would reintroduce a cycle at run time. | LP-02 | S |

## 2. Decision handling (LP)

| ID | Behavior | Reference | Status |
|---|---|---|---|
| LP-06 | For every call the Layer MUST ask the decider before calling `next`, passing the operation id as the tool, the domain arguments, the envelope, the transport and the attributes when present. | `IPolicyDecider` | S |
| LP-07 | On `allow` the Layer MUST call `next`. Any `set` values returned MUST replace the matching domain arguments before `next` is called, so apigen's validate layer (which runs after `--use` layers) validates the forced values. | PM-05, IN-10 | S |
| LP-08 | On `deny` the Layer MUST NOT call `next` and MUST throw apigen's `permission_denied` error. The function MUST NOT run. | SV-08 | S |
| LP-09 | The Layer MUST read attributes from the call envelope, where an earlier `--use` layer (an auth layer) writes them. It declares no field that a caller can set to assert its own attributes. When the envelope has none, the decider receives none and evaluates with the empty set (AT-09). | apigen SPEC section 9.1; SC-08 | U |
| LP-10 | On `ask` the Layer MUST call the optional `ask` handler from the plugin options. With no handler, or when the handler rejects or times out, the result MUST be `deny`. | AK-03 | S |
| LP-11 | The Layer MUST fail closed: a decider that rejects, exceeds its optional deadline or returns a value outside the port's shape MUST produce `deny`, never `allow`. | FC-01 | S |
| LP-12 | The decision is made once, before the call. For a streaming operation the Layer MUST NOT inspect or gate individual chunks. | NG-01 | S |
| LP-13 | The Layer MUST hold no state. Counters belong to the decider's runtime provider (RT-07, RT-08). | SV-09 | S |
| LP-14 | The Layer SHOULD be the outermost `--use` layer after the attribute provider (the auth layer), so no other layer's side effect runs before the decision. The documentation MUST say so. | apigen SPEC section 8.1 | S |
| LP-15 | The Layer MUST treat every operation uniformly. An operation with no matching permission is denied (PM no-match rule). A deployer who wants an operation ungoverned excludes the plugin from that host, not from one operation. | PM-09 | S |
| LP-16 | The Layer MUST behave identically on every transport apigen serves; the transport is passed to the decider for audit only. | SV-04 | S |
| LP-17 | The Layer MUST work with an in-process decider and nothing else running: no policy server, no network, no other package (the standalone rule of WM-08 applied to this consumer). | WM-08 | S |

## 3. Proof suite (LPS)

| ID | Test | Behaviors covered | Negative control |
|---|---|---|---|
| LPS-01 | A fixture operation set is served by the real apigen CLI and the real apigen MCP host with the plugin loaded through `--use` and the real `@adhd/policy` decider. An allowed call runs; a denied call returns `permission_denied` and the function's side-effect marker stays unset; a forced `set` value is what the function receives; an `ask` with no handler is denied. The test lives in `entrypoint/policy` (LP-02). | LP-03 to LP-08, LP-10, LP-16, LP-17 | Serve the same set without the Layer: the denied call runs |
| LPS-02 | A decider that throws, times out or returns garbage yields `permission_denied`. | LP-11 | Treat a decider error as `allow` |
| LPS-03 | The import-graph test fails if the plugin imports `@adhd/policy` or if `@adhd/policy` source imports the plugin. | LP-02, LP-05 | Add the forbidden import |

## 4. Non-goals

| ID | Behavior | Reference | Status |
|---|---|---|---|
| LP-18 | The plugin does not wrap a foreign MCP server or command. apigen's `remote` and `bin` sources do (`architect-spec-sources.md`, OD-32); the plugin governs whatever operations those sources produce. | SRC-01 | S |
| LP-19 | The plugin does not filter responses. | NG-01 | S |
| LP-20 | The plugin is tied to no auth layer. An auth layer is any earlier layer that writes attributes to the envelope (SC-03); the plugin works with none (SC-05). | SC-02 | S |

## 5. Open items

| ID | Item |
|---|---|
| LP-O1 | Package name and approval (BO-06). |
| LP-O2 | Whether apigen's CLI and MCP hosts deliver `--use` options and envelope fields to a Layer as the SPEC describes (`readUseOptions` exists in `apigen-engine-runtime`; end-to-end delivery on each host is unverified). |
