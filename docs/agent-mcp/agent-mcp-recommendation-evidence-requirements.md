# What Maintainers Need to Build Before `@adhd/agent-mcp` Is Easy to Recommend

The project needs an **evidence surface**, not merely more implementation.

A technically competent reviewer should be able to answer, within 30–60 minutes:

- What does this project do?
- What can it access?
- How is it constrained?
- What happens when it fails?
- Can its security and reliability claims be independently verified?
- Is it maintained well enough to trust?

The bulk of that evaluation could be covered by the deliverables below.

---

## 1. A Serious Architecture and Security Document

Create one canonical document, for example:

```text
docs/architecture-and-security.md
```

It should explain:

- system boundaries;
- process model;
- state model;
- provider abstraction;
- MCP client/server relationships;
- parent/child agent lifecycle;
- permission inheritance;
- filesystem and network access;
- secret handling;
- trust boundaries;
- persistence;
- cancellation;
- failure recovery.

A high-level architecture diagram should make the system immediately legible:

```text
MCP Client
    |
    v
Agent MCP Server
    |
    +-- Policy Engine
    +-- Agent Supervisor
    +-- State Store
    +-- Provider Adapters
    +-- Tool Gateway
            |
            +-- Filesystem
            +-- Shell
            +-- Network
            +-- External MCP Servers
```

The documentation should explicitly distinguish controls that are:

```text
Enforced by runtime
Enforced by OS isolation
Enforced by provider
Suggested only through prompts
Not currently supported
```

That distinction is critical. Prompt-level behavior should never be presented as a security boundary.

---

## 2. A Machine-Enforced Policy and Budget Layer

The highest-value subsystem the maintainers could build is a runtime policy engine.

A representative policy model might look like:

```ts
type AgentPolicy = {
  maxDepth: number;
  maxChildren: number;
  maxTotalAgents: number;
  timeoutMs: number;
  maxToolCalls: number;
  maxTokens?: number;
  maxCostUsd?: number;

  filesystem: {
    read: string[];
    write: string[];
  };

  network: {
    enabled: boolean;
    allowHosts?: string[];
  };

  tools: {
    allow: string[];
    deny: string[];
    requireApproval: string[];
  };

  environment: {
    allow: string[];
  };
};
```

The core invariant should be enforced in code:

```text
child capabilities subset-of parent capabilities
```

For example:

```ts
if (!isSubset(childPolicy, parentPolicy)) {
  throw new PermissionEscalationError();
}
```

This subsystem would answer a large portion of the security, recursion, spending, and side-effect questions.

### Minimum runtime controls

The policy engine should enforce:

- maximum delegation depth;
- maximum children per agent;
- maximum total agents per run;
- token limits;
- cost limits;
- wall-clock timeouts;
- tool-call limits;
- concurrency limits;
- filesystem scopes;
- network scopes;
- environment variable access;
- human approval requirements;
- cancellation propagation.

These controls must be enforced by the runtime, not only written into prompts.

---

## 3. An Observable Agent Inspector

The project should expose a human-readable and machine-readable view of every running agent.

Possible commands:

```bash
agent-mcp inspect
agent-mcp agents
agent-mcp trace <run-id>
agent-mcp policy explain <agent-id>
```

Equivalent MCP resources or tools would also work.

A reviewer should be able to inspect data like:

```json
{
  "runId": "run_123",
  "agentId": "agent_7",
  "parentId": "agent_2",
  "status": "running",
  "task": "Review authentication implementation",
  "provider": "anthropic",
  "model": "claude-sonnet",
  "depth": 2,
  "capabilities": {
    "tools": ["repo.search", "fs.read"],
    "filesystemWrite": false,
    "network": false
  },
  "budget": {
    "maxTokens": 20000,
    "usedTokens": 8421,
    "maxCostUsd": 0.5,
    "usedCostUsd": 0.17
  },
  "startedAt": "...",
  "deadline": "..."
}
```

The trace should include:

- spawn decisions;
- tool calls;
- policy checks;
- approvals;
- provider requests;
- retries;
- cancellations;
- child completion;
- token usage;
- cost accounting;
- external side effects.

Without this, reviewers are forced to infer behavior from source code.

---

## 4. An Executable Assurance Suite

The maintainers should create a dedicated test suite designed to prove the project's safety and lifecycle guarantees.

A suitable structure would be:

```text
tests/assurance/
```

Example tests:

```text
child-cannot-escalate-tools.test.ts
child-cannot-expand-filesystem-scope.test.ts
max-depth-is-enforced.test.ts
global-agent-limit-is-enforced.test.ts
cost-budget-stops-run.test.ts
cancellation-propagates-to-children.test.ts
secrets-are-not-persisted.test.ts
state-recovers-after-crash.test.ts
non-idempotent-tools-are-not-retried.test.ts
symlink-escape-is-blocked.test.ts
orphaned-agents-are-terminated.test.ts
provider-timeout-is-contained.test.ts
```

The project should include a one-command verifier:

```bash
npm run assurance
```

Ideally, the command would produce a concise report:

```text
Security invariants:       18/18 passed
Lifecycle invariants:      12/12 passed
Provider conformance:       4/4 passed
Failure recovery cases:     9/9 passed
```

This makes independent evaluation much easier than reading implementation details manually.

---

## 5. A Runnable Threat-Model Demo

The repository should contain an intentionally adversarial demonstration environment:

```text
examples/security-lab/
```

The demo should attempt to make a child agent:

- read `.env`;
- access `~/.ssh`;
- write outside the workspace;
- call a denied tool;
- spawn beyond the configured maximum depth;
- exceed its cost budget;
- contact an unapproved host;
- inherit a parent-only secret;
- continue running after cancellation;
- trick the supervisor through prompt injection.

The runtime should visibly reject these actions.

Example output:

```text
DENIED fs.read ~/.ssh/id_rsa
Reason: path outside permitted roots

DENIED agent.spawn
Reason: maximum delegation depth reached

DENIED tool.call deploy.production
Reason: human approval required

TERMINATED agent_12
Reason: run cost budget exceeded
```

This is far more persuasive than a generic security statement in the README.

---

## 6. A Provider Conformance Harness

If provider abstraction is a core claim, it should be backed by a compatibility test harness.

Suggested location:

```text
packages/provider-conformance/
```

Every provider adapter should be tested for:

- basic generation;
- streaming;
- tool calls;
- parallel tool calls;
- structured output;
- cancellation;
- timeout handling;
- token usage;
- cost accounting;
- context overflow;
- malformed responses;
- retry classification.

The repository should publish a compatibility matrix similar to:

| Capability | OpenAI | Anthropic | Gemini | Local |
|---|---:|---:|---:|---:|
| Streaming | Yes | Yes | Yes | Partial |
| Tool calls | Yes | Yes | Yes | Adapter-dependent |
| Parallel tools | Yes | Yes | Partial | No |
| Cancellation | Yes | Partial | Yes | Yes |
| Accurate usage accounting | Yes | Yes | Partial | Estimated |
| Structured output | Native | Emulated | Native | Emulated |

This prevents “provider abstraction” from becoming an untestable marketing claim.

---

## 7. Clear Documentation Structure

A strong repository should make evidence easy to navigate.

Recommended layout:

```text
README.md
SECURITY.md
THREAT_MODEL.md
docs/
  architecture.md
  agent-lifecycle.md
  permissions.md
  state-and-persistence.md
  failure-semantics.md
  provider-support.md
  observability.md
  production-readiness.md
examples/
  read-only-research/
  bounded-delegation/
  human-approved-writes/
  security-lab/
tests/
  assurance/
  provider-conformance/
  chaos/
```

The README should serve as an index rather than attempting to hold all implementation and security details.

### The README should immediately state

- what the project is;
- what it is not;
- current maturity level;
- default security posture;
- supported providers;
- supported isolation modes;
- known limitations;
- a minimal safe example;
- links to architecture and assurance evidence.

An effective default-security section might say:

```text
By default:

- child agents cannot gain permissions;
- filesystem access is read-only and workspace-scoped;
- network access is disabled;
- delegation depth is limited to 2;
- all writes require approval;
- run cost is capped;
- state is stored locally in SQLite;
- environment variables are denied unless explicitly allowed.
```

That paragraph would answer many initial reviewer questions.

---

## 8. Operational and Release Evidence

The project should publish CI results for:

```text
build
unit tests
integration tests
assurance tests
provider conformance
dependency audit
secret scan
static analysis
license scan
reproducible package check
npm artifact diff
```

The npm artifact diff is especially valuable. It should verify that the published package contains only expected files and corresponds to the repository tag.

The maintainers should also publish:

- test coverage;
- supported Node.js versions;
- dependency update cadence;
- release history;
- security response policy;
- maintenance status;
- backward compatibility policy.

---

## 9. Verifiable Package Provenance

A reviewer should be able to follow this chain:

```text
npm package
-> source repository
-> release tag
-> CI run
-> build artifact
-> provenance record
```

The project should provide:

- npm trusted publishing;
- repository-linked package metadata;
- signed tags or releases;
- a generated SBOM;
- provenance attestations;
- published package contents visible in CI;
- no undocumented install or postinstall behavior.

Without clear provenance, reviewers cannot reliably establish that the published package matches the reviewed source.

---

## 10. A Production-Readiness Matrix

The maintainers should publish a direct, non-marketing status table.

For example:

| Area | Status | Evidence |
|---|---|---|
| Permission non-escalation | Enforced | Test and design document |
| Delegation depth limits | Enforced | Assurance test |
| Cost limits | Enforced | Integration test |
| Filesystem isolation | Workspace-scoped | Threat-model demo |
| Network restrictions | Allowlist | Policy documentation |
| Crash recovery | Experimental | Recovery tests |
| Multi-user isolation | Not supported | Known limitations |
| Provider portability | Partial | Conformance matrix |
| External security audit | Not completed | — |
| Production recommendation | No | Maturity policy |

This is substantially more trustworthy than describing the project as simply “secure” or “production-ready.”

---

# Minimal High-Leverage Package

To cover roughly 80% of the concerns involved in recommending the project, the maintainers should build and publish:

1. A runtime-enforced capability and budget system.
2. A structured execution trace and inspector.
3. An assurance test suite.
4. A runnable threat-model demo.
5. A provider conformance suite.
6. Architecture, security, and failure-semantics documentation.
7. Verifiable package provenance.

The most important principle is that the evidence should be **executable**.

A claim such as:

```text
Children cannot exceed parent permissions.
```

should be backed by all of the following:

```text
policy implementation
+ invariant test
+ trace showing rejection
+ documentation
```

That combination turns a feature claim into evidence strong enough for an independent reviewer to recommend the project.
