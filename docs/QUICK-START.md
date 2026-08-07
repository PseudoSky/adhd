# Quick Start Guide

Get your first @adhd agent or API running in 5 minutes.

## Pick Your Path

### 1. Run an Agent (MCP Server)

Want to spawn agents and delegate tasks?

```bash
npx @adhd/agent-mcp
```

For the full guide, see [`entrypoint/agent-mcp/README.md`](../entrypoint/agent-mcp/README.md).

### 2. Generate an API

Want to turn TypeScript functions into HTTP/MCP/CLI APIs?

```bash
npx @adhd/apigen-cli run --source ./api.ts --type mcp
```

For the full guide, see [`entrypoint/apigen-cli/README.md`](../entrypoint/apigen-cli/README.md).

### 3. Orchestrate Tasks (DAG)

Want to run parallel tasks with cost estimation?

```bash
npx @adhd/dispatch-cli run ./workflow.dag.json
```

For the full guide, see [`entrypoint/dispatch-cli/README.md`](../entrypoint/dispatch-cli/README.md).

## Next Steps

- **Learn the architecture:** [docs/ARCHITECTURE.md](ARCHITECTURE.md)
- **Contribute:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Publish packages:** [PUBLISHING.md](../PUBLISHING.md)
- **Configure environments:** [docs/environment/](environment/)
