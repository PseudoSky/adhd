# Agent Discovery Plan for the `@adhd/agent-*` Package Family

> **Important scope note:** The actual sibling packages in the `@adhd/agent-*` namespace have not yet been verified. Package names and responsibilities used in this document are hypothetical examples only. This plan describes the discovery architecture the package family should adopt once the real package inventory is available; it is not an assessment of the current package suite.

## Objective

Make the complete `@adhd/agent-*` suite discoverable as a coherent platform while ensuring that autonomous agents select the correct individual package.

The desired discovery path is:

```text
task intent
→ @adhd agent ecosystem
→ appropriate package
→ appropriate exported capability
→ successful integration
```

The package family should avoid two common failures:

```text
Failure 1:
Every package looks like a general-purpose agent framework.

Failure 2:
Only @adhd/agent-mcp is discoverable, while its supporting packages
appear to be unrelated implementation dependencies.
```

The solution is a two-level discovery model:

```text
Ecosystem-level discovery
        ↓
Package-level selection
```

---

## 1. Create a Canonical Ecosystem Manifest

The monorepo should contain one authoritative manifest describing the complete package family.

Suggested location:

```text
agent-ecosystem.json
```

Illustrative structure:

```json
{
  "name": "@adhd/agent",
  "title": "ADHD Agent Platform",
  "description": "A modular runtime and integration suite for building, supervising, and exposing bounded AI agents.",
  "packages": [
    {
      "name": "@adhd/agent-core",
      "role": "runtime",
      "summary": "Core agent lifecycle, state, and execution primitives."
    },
    {
      "name": "@adhd/agent-mcp",
      "role": "protocol-adapter",
      "summary": "Exposes the agent runtime to MCP clients."
    },
    {
      "name": "@adhd/agent-openai",
      "role": "provider-adapter",
      "summary": "Runs agents through supported OpenAI model APIs."
    }
  ]
}
```

All package names other than the already discussed `@adhd/agent-mcp` are illustrative placeholders until the real package inventory is verified.

The actual package inventory should be generated from workspace metadata rather than manually duplicated.

### Required fields per package

Each package entry should identify:

- package name;
- stable package ID;
- package category;
- one-sentence responsibility;
- capabilities;
- common task intents;
- intended users;
- direct installation status;
- public versus internal status;
- dependencies within the package family;
- packages commonly used alongside it;
- packages it should not be confused with;
- maturity;
- documentation URL;
- source directory;
- release version.

### Why this matters

An agent should be able to answer:

> Which `@adhd/agent-*` package do I need?

without comparing a dozen nearly identical npm descriptions.

---

## 2. Assign Every Package One Discovery Role

Each package should belong to one clear category.

Recommended categories include:

| Category | Purpose | Illustrative package |
|---|---|---|
| Runtime | Core execution and lifecycle semantics | `agent-core` |
| Protocol adapter | Exposes the runtime through a protocol | `agent-mcp` |
| Provider adapter | Connects the runtime to a model provider | `agent-openai` |
| Tool adapter | Makes an external tool system available | `agent-tools-*` |
| State adapter | Implements persistence or memory | `agent-state-*` |
| Policy module | Provides permission or budget enforcement | `agent-policy` |
| Observability module | Provides tracing and metrics | `agent-observability` |
| SDK | Developer-facing composition API | `agent-sdk` |
| Application | Ready-to-run agent product | `agent-cli` |
| Internal package | Shared implementation not intended for selection | private workspace package |

Every public package should have one primary role.

A package may expose several features, but its discovery identity must remain narrow.

---

## 3. Distinguish Selectable Packages from Implementation Packages

Not every published package should be optimized for direct agent selection.

Classify packages as:

```text
User-selectable
Agent-selectable
Dependency-only
Internal
Deprecated
```

### User-selectable

A developer intentionally installs it.

Illustrative examples:

```text
@adhd/agent-mcp
@adhd/agent-sdk
@adhd/agent-cli
```

These need full descriptions, examples, comparison guidance, and machine-readable manifests.

### Agent-selectable

An autonomous development agent may choose it when implementing a requirement.

Illustrative examples:

```text
@adhd/agent-openai
@adhd/agent-state-sqlite
@adhd/agent-observability
```

These need precise capability metadata and explicit compatibility information.

### Dependency-only

Normally installed transitively.

Illustrative examples:

```text
@adhd/agent-types
@adhd/agent-internal
@adhd/agent-protocol
```

Their metadata should explicitly say:

> Internal building block. Most users should not install this package directly.

This prevents search systems from recommending low-level packages as complete solutions.

---

## 4. Give Every Package a Distinct Task-Oriented Description

Package descriptions should explain the selection boundary, not just the implementation.

### Weak package family

```text
@adhd/agent-core
Core tools for agents.

@adhd/agent-runtime
Agent runtime utilities.

@adhd/agent-sdk
SDK for agent runtimes.
```

These descriptions are semantically indistinguishable.

### Better package family

```text
@adhd/agent-core

Defines provider-independent agent execution, lifecycle, delegation,
state, cancellation, and policy primitives. Use it when embedding the
runtime directly in a TypeScript application.
```

```text
@adhd/agent-mcp

Exposes an existing ADHD Agent runtime as an MCP server. Use it when an
MCP client needs to create, inspect, message, wait for, or cancel agents.
```

```text
@adhd/agent-openai

Implements the ADHD Agent provider interface for OpenAI APIs. Use it with
agent-core when agents should execute using supported OpenAI models.
```

Again, these sibling package names are examples, not verified inventory.

Each description should answer:

```text
What does this package own?
When should it be installed?
What must it be combined with?
What should not be installed instead?
```

---

## 5. Publish a Package Selection Matrix

Create one canonical page:

```text
docs/choosing-a-package.md
```

It should map task intent to package selection.

Illustrative matrix:

| I need to… | Install | Usually combine with |
|---|---|---|
| Embed the agent runtime in a TypeScript application | `agent-core` | provider and state adapters |
| Expose agents to Claude, Codex, or another MCP client | `agent-mcp` | runtime and a provider |
| Run agents through OpenAI | `agent-openai` | runtime |
| Persist agent state in SQLite | `agent-state-sqlite` | runtime |
| Add tracing and execution metrics | `agent-observability` | runtime or MCP package |
| Build a ready-to-run local service | `agent-cli` | usually none |
| Implement a custom provider | `agent-sdk` or provider interface | runtime |

Also include negative decisions:

| I need to… | Do not select |
|---|---|
| Expose a runtime over MCP | A provider adapter alone |
| Add OpenAI support | `agent-mcp` alone |
| Use only shared TypeScript types | The full runtime |
| Sandbox untrusted processes | Any package unless an explicit isolation module provides it |

Negative mappings help agents avoid plausible but incorrect selections.

---

## 6. Add a Manifest to Every Public Package

Each public package should contain a small package-level manifest.

Suggested location:

```text
agent-package.json
```

Illustrative example:

```json
{
  "name": "@adhd/agent-mcp",
  "category": "protocol-adapter",
  "directInstall": true,
  "purpose": "Expose an ADHD Agent runtime through MCP.",
  "capabilities": [
    "mcp_server",
    "agent_spawn",
    "agent_status",
    "agent_message",
    "agent_wait",
    "agent_cancel",
    "agent_trace"
  ],
  "useWhen": [
    "an MCP client must control child agents",
    "agent lifecycle operations must be exposed through MCP"
  ],
  "doNotUseWhen": [
    "only an in-process TypeScript runtime is required",
    "OS-level sandboxing is the primary requirement"
  ],
  "requires": [
    "runtime package",
    "one compatible provider adapter"
  ],
  "commonCombinations": [
    "provider adapter",
    "state adapter"
  ]
}
```

The ecosystem manifest should aggregate these package manifests automatically.

---

## 7. Define Composition Recipes

Most package-family queries are not asking for one package. They are asking for a working stack.

Publish named composition recipes such as:

```text
MCP Starter
Embedded TypeScript Runtime
Persistent Local Runtime
Observable Production Runtime
Multi-Provider Runtime
Read-Only Research Agent
```

Illustrative examples:

### MCP Starter

```text
runtime package
+ @adhd/agent-mcp
+ one provider adapter
```

### Persistent local runtime

```text
runtime package
+ one provider adapter
+ SQLite state adapter
```

### Observable deployment

```text
runtime package
+ provider adapter
+ state adapter
+ policy package
+ observability package
```

Each recipe should include:

- user intent;
- required packages;
- optional packages;
- installation command;
- minimal configuration;
- expected capabilities;
- omitted capabilities;
- security defaults;
- runnable verification command.

Agents are more likely to produce a correct integration when the ecosystem publishes supported combinations directly.

---

## 8. Define Compatibility as Structured Data

The package family needs a machine-readable compatibility matrix.

It should cover:

- supported package version ranges;
- Node.js versions;
- MCP protocol versions;
- provider capabilities;
- storage adapters;
- transport support;
- optional peer dependencies;
- browser versus server support;
- ESM and CommonJS status.

Illustrative format:

```json
{
  "package": "@adhd/agent-mcp",
  "version": "1.2.0",
  "compatibleWith": {
    "runtime-package": "^1.2.0",
    "openai-provider-package": "^1.1.0",
    "sqlite-state-package": "^1.0.0"
  },
  "runtime": {
    "node": ">=22",
    "browser": false
  }
}
```

This should be generated and validated in CI.

An agent should not need to infer compatibility from peer-dependency warnings after installation.

---

## 9. Avoid Package Cannibalization

Closely named packages can compete against one another in semantic search.

For every pair of adjacent packages, document the distinction explicitly.

Illustrative comparisons:

```text
agent-core vs agent-sdk
agent-core vs agent-runtime
agent-mcp vs agent-cli
agent-policy vs agent-sandbox
agent-memory vs agent-state
agent-provider-* vs agent-model-*
```

Use a repeatable comparison format:

| Question | Package A | Package B |
|---|---|---|
| Primary user | Runtime integrator | Extension author |
| Runs agents | Yes | No |
| Defines public interfaces | Yes | Yes |
| Intended for direct installation | Yes | Only for extensions |
| Typical task query | “embed an agent runtime” | “build an adapter” |

Where two packages cannot be clearly distinguished, the team should consider:

- merging them;
- renaming one;
- marking one internal;
- deprecating one;
- positioning one as an explicit subpath export instead.

ASEO can expose poor package architecture; it cannot fully compensate for it.

---

## 10. Use Naming That Encodes Selection Semantics

The package suffix should identify its role.

Recommended illustrative patterns:

```text
agent-core
agent-sdk
agent-mcp
agent-cli

agent-provider-openai
agent-provider-anthropic

agent-state-memory
agent-state-sqlite
agent-state-postgres

agent-policy-default
agent-policy-enterprise

agent-observability-otel
agent-transport-http
```

Avoid mixing patterns such as:

```text
agent-openai
agent-provider-anthropic
agent-gemini-adapter
agent-model-local
```

unless those packages genuinely have different responsibilities.

Consistent names improve both human and embedding-based package selection.

---

## 11. Give Internal Packages Deliberately Low Discovery Priority

Internal packages should not compete with end-user packages.

For dependency-only packages:

- mark them private where practical;
- omit broad marketing keywords;
- state that direct installation is unsupported;
- link to the correct public entry point;
- avoid generic descriptions such as “tools for building AI agents”;
- avoid registering them in agent directories;
- exclude them from the public selection matrix except where necessary.

Illustrative npm description:

> Internal protocol types for the ADHD Agent package family. Not a standalone runtime; most users should install the main runtime package or `@adhd/agent-mcp`.

---

## 12. Create Ecosystem-Level Examples

Package examples should show individual functionality, but the monorepo also needs end-to-end examples spanning multiple packages.

Suggested illustrative structure:

```text
examples/
  mcp-openai-memory/
  mcp-anthropic-sqlite/
  embedded-multi-provider/
  observable-agent-service/
  custom-provider-adapter/
  minimal-core-runtime/
```

Each example should record:

```yaml
intent: Expose persistent OpenAI-backed agents to an MCP client

packages:
  - "runtime package"
  - "@adhd/agent-mcp"
  - "OpenAI provider package"
  - "SQLite state package"

provides:
  - MCP agent lifecycle
  - OpenAI model execution
  - persistent local state

does_not_provide:
  - OS-level process isolation
  - distributed multi-user execution
```

This gives agent search systems a direct mapping from user intent to a valid package set.

---

## 13. Evaluate Package Selection, Not Just Ecosystem Retrieval

The ASEO benchmark should test two separate questions.

### Ecosystem retrieval

Does the query retrieve the ADHD Agent package family?

Example:

```text
Find a TypeScript runtime for supervising child agents through MCP.
```

### Intra-ecosystem selection

Once the ecosystem is found, does the agent choose the correct package or package combination?

Illustrative examples:

```text
I already have the runtime and need MCP access.
```

Expected:

```text
@adhd/agent-mcp
```

```text
I need to add SQLite persistence to an existing runtime.
```

Expected:

```text
the verified SQLite state adapter package
```

```text
I want to implement a new model provider.
```

Expected:

```text
the verified provider interface or SDK package
```

### Metrics

Track:

- ecosystem recall;
- correct package selection;
- correct package-set selection;
- unnecessary package rate;
- missing dependency rate;
- internal-package false selection;
- incompatible-version recommendation rate;
- correct installation order;
- successful example execution.

---

## 14. Generate Documentation and Metadata from One Package Graph

The team should not manually maintain package relationships in multiple places.

Create a package graph as the source of truth:

```text
package manifests
        ↓
ecosystem graph
        ↓
README package table
selection matrix
registry metadata
compatibility matrix
documentation pages
discovery benchmark expectations
```

Suggested build commands:

```bash
npm run metadata:validate
npm run metadata:generate
npm run discovery:test
```

CI should fail when:

- a public package lacks a manifest;
- two packages claim the same primary role;
- dependencies contradict the documented package graph;
- a direct-install package lacks a runnable example;
- a dependency-only package is advertised as standalone;
- compatibility metadata is stale;
- package descriptions become too similar.

---

## 15. Recommended Developer Work Plan

### Milestone 1: Inventory and Classification

- Verify every real `@adhd/agent-*` package.
- Mark each as public, internal, dependency-only, or deprecated.
- Assign one category and one primary role.
- Identify packages with overlapping responsibilities.
- Decide which package is the default entry point.

#### Output

```text
docs/package-inventory.md
agent-ecosystem.json
```

### Milestone 2: Package Identity

- Define canonical package names.
- Write distinct one-sentence descriptions.
- Add use-when and do-not-use guidance.
- Create one `agent-package.json` per public package.
- Standardize package keywords and repository links.

#### Output

Every package has a unique, machine-readable selection identity.

### Milestone 3: Selection and Composition

- Publish the package selection matrix.
- Define supported composition recipes.
- Publish the compatibility matrix.
- Add installation commands for each recipe.
- Document common incorrect combinations.

#### Output

Agents can choose valid package sets rather than isolated packages.

### Milestone 4: Executable Evidence

- Build one runnable example for each selectable package.
- Build end-to-end examples for major compositions.
- Record expected capabilities and limitations.
- Execute examples in CI.
- Publish results alongside release metadata.

#### Output

Package-selection claims are connected to working integrations.

### Milestone 5: Discovery Evaluation

- Add ecosystem-level queries.
- Add package-selection queries.
- Add negative queries.
- Test against competing packages and against sibling-package confusion.
- Add regression thresholds to CI.

#### Output

The team can measure whether agents select the right sibling package.

---

## Priority Backlog

### Priority 0

- Produce and verify the complete package inventory.
- Identify the recommended top-level entry point.
- Classify every package.
- Resolve ambiguous or overlapping package roles.
- Create the ecosystem manifest.

### Priority 1

- Add package-level manifests.
- Rewrite npm descriptions.
- Publish the package selection matrix.
- Document supported package compositions.
- Mark internal packages clearly.

### Priority 2

- Publish compatibility metadata.
- Add end-to-end composition examples.
- Generate ecosystem documentation from the package graph.
- Build intra-ecosystem package-selection evaluations.

### Priority 3

- Publish benchmark results.
- Integrate discovery regression testing into releases.
- Automate registry entries.
- Consider renaming or consolidating packages with persistent selection confusion.

---

## Definition of Done

The `@adhd/agent-*` family is properly optimized for agent discovery when an autonomous development agent can:

1. discover the overall ecosystem;
2. identify the responsibility of each verified package;
3. distinguish adjacent packages;
4. select the minimum correct package set;
5. avoid internal and dependency-only packages;
6. choose compatible versions;
7. follow a supported composition recipe;
8. execute a working example;
9. explain what capabilities the selected stack does and does not provide.

The core architecture should be:

```text
one ecosystem identity
+ distinct package identities
+ structured package relationships
+ executable composition recipes
+ measured package-selection accuracy
```

The key principle is that discovery should optimize for the **smallest correct package composition**, not merely visibility for every package in the namespace.
