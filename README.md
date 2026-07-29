# @adhd — Agent Hierarchical Distributed Domain

A **production-grade agent framework** for building multi-model orchestration systems with modular registries, composable prompt engineering, and real-time tool management.

## Why this exists

Building intelligent agents that work across multiple LLM providers, safely manage tool access, and adapt behavior based on policies requires infrastructure. Existing frameworks either couple agent logic to a single provider or demand custom glue code. **@adhd** separates these concerns: define agents, prompts, and tools once in a SQLite registry, then compile them to any platform — MCP servers, HTTP APIs, CLI tools, or cloud functions — with zero reimplementation.

## Product story

@adhd is a **foundational agent OS** for teams building systems where:

- **Multiple LLMs are standard.** Switch models, providers, or strategies without code changes.
- **Tool access is policy-driven.** Grant or revoke capabilities at runtime via role-based, category-based, or dynamic policies.
- **Prompt composition is systematic.** Build complex agent behaviors from reusable components (system instructions, error guidance, behavioral rules) instead of monolithic templates.
- **Transport is flexible.** The same agent definition runs as an MCP server (for Claude Desktop), HTTP API (for web apps), or CLI tool (for automation).
- **Reproducibility matters.** Every agent, tool, policy, and model is versioned in a central registry; compile auditable agent configs on demand.

## Getting started

Each subproject has its own quick-start guide. Start here based on your goal:

| Subproject | Purpose | Entry point |
|------------|---------|-------------|
| **agent-mcp** | Run agents as MCP servers; spawn agents, delegate across providers, HITL suspension | [`entrypoint/agent-mcp/README.md`](entrypoint/agent-mcp/README.md) |
| **apigen-cli** | Code-first API generation: TypeScript → HTTP, MCP, CLI, OpenAPI, Python; batch/bulk fan-out operations | [`entrypoint/apigen-cli/README.md`](entrypoint/apigen-cli/README.md) |
| **dispatch-cli** | Orchestrate task DAGs: validate, optimize, execute with cost estimation | [`entrypoint/dispatch-cli/README.md`](entrypoint/dispatch-cli/README.md) |
| **environment** | Zero-config configuration cascade (code defaults → system → global → project → env) | [`docs/environment/`](docs/environment/) |
| **agent-registry family** | Core modular packages: stores for prompts, tools, policies, models; compiler | [`packages/agent/README.md`](packages/agent/README.md) |
| **apigen-plugins** | Transport adapters: Fastify, Express, gRPC, Python Flask, OpenAPI, JSON Schema | [`packages/apigen/README.md`](packages/apigen/README.md) |

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  Monorepo: 50 packages across 7 domains                    │
├─────────────────────────────────────────────────────────────┤
│  Entrypoints (users interact here):                         │
│    • entrypoint/agent-mcp — MCP server runner              │
│    • entrypoint/apigen-cli — API generator CLI             │
│    • entrypoint/dispatch-cli — DAG orchestrator CLI        │
├─────────────────────────────────────────────────────────────┤
│  Agent Registry Family (the core system):                   │
│    • agent-store-prompts — component composition engine    │
│    • agent-store-tools — tool registry & bindings         │
│    • agent-core-policy — runtime authorization engine     │
│    • agent-core-provider — LLM provider/model registry    │
│    • agent-engine-compiler — compile registry → configs   │
│    • agent-core-env — shared DB resolver (zero side-fx)   │
├─────────────────────────────────────────────────────────────┤
│  Ecosystem:                                                  │
│    • apigen-core-* — code-first API generation             │
│    • apigen-plugin-* — transport adapters + batch ops      │
│    • dispatch-* — DAG execution & optimization             │
│    • environment-* — config cascade & defaults             │
│    • data-* — shared utilities (transforms, query engine)  │
│    • ui-react-* — dashboard components                     │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** Every capability is versioned, stored in the registry, and compiled to deployment targets on demand. No code generation, no coupling to a single provider or transport.

## Learn more

- **[Quick-start guide](docs/QUICK-START.md)** — First agent/API/task in 5 minutes
- **[Architecture](docs/ARCHITECTURE.md)** — Monorepo structure, tier hierarchy, platform isolation rules
- **[Contributing](CONTRIBUTING.md)** — Code conventions, testing, package scaffolding
- **[Environment configuration](docs/environment/)** — Zero-config cascade: code → system → global → project → env

## Publishing & releases

See [PUBLISHING.md](PUBLISHING.md) for the version-bump, build, and publish workflow.

## Community

- **Report issues:** [GitHub Issues](https://github.com/PseudoSky/adhd/issues)
- **License:** [MIT](LICENSE)
- **Security:** [SECURITY.md](SECURITY.md)
