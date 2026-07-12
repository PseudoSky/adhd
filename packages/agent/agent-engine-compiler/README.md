# @adhd/agent-engine-compiler

Compilation and code-generation tooling for @adhd/agent-mcp. Generates agent prompts, tool schemas, validation, and optimizations at build time.

**Status:** Compiler (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-engine-compiler`  
**Consumers:** `@adhd/agent-mcp`

## What it does

- **Agent schema generation** — derives tool schemas and agent config from type definitions
- **Prompt optimization** — compiles system prompts with tool descriptions and error guidance
- **Validation generation** — creates Zod schemas for runtime input validation
- **Registry integration** — optional compilation with agent registries for metadata

## Architecture

- Part of the 6-package agent framework family
- Depends on: `@adhd/agent-base-types`
- Depended on by: `@adhd/agent-mcp` (optional; used for optimized builds)

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
