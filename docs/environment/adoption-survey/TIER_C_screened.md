# TIER C Screening Results

**Summary: 1 candidate, 19 skips**

| package | root | lang | signal | verdict | gaps | reason |
|---------|------|------|--------|---------|------|--------|
| @adhd/sox-nx | sox-ecosystem | ts | [-F--] | skip | — | Nx executor, build-time output routing |
| @adhd/sox-hybrid-search | sox-ecosystem | ts | [---D] | skip | — | Pure ranking library, no state |
| @adhd/sox-source-provider | sox-ecosystem | ts | [-F--] | skip | — | I/O layer only, no caching |
| @adhd/sox-ingest | sox-ecosystem | ts | [--L-] | skip | — | Pure stateless functions per manifest |
| @adhd/sox-analysis | sox-ecosystem | ts | [---D] | skip | — | Data analysis library |
| @adhd/decompile-cli | adhd | ts | [E---] | skip | — | Transient build artifact generation |
| @adhd/agent-plugin-sanitize | adhd | ts | [---D] | skip | — | Plugin, no persistent state |
| @adhd/workspace-base-tools | adhd | ts | [-F--] | skip | — | Workspace dev-tools |
| @adhd/agent-generator-plugin | adhd | ts | [---D] | skip | — | Code generator, build-time |
| @adhd/dispatch-base-spec | adhd | ts | [-F--] | skip | — | Spec/types only |
| @adhd/dispatch-core-client | adhd | ts | [-F--] | skip | — | Client library, no state |
| @adhd/workspace-codegen-nx | adhd | ts | [-F--] | skip | — | Nx generator, dev-time |
| @adhd/apigen-plugin-api-fastify | adhd | ts | [--L-] | skip | — | Parameter-driven server, shared logger |
| @adhd/dispatch-core-optimizer | adhd | ts | [-F--] | skip | — | Pure library |
| @adhd/apigen-plugin-mcp | adhd | ts | [--L-] | skip | — | Parameter-driven server, shared logger |
| @adhd/apigen-plugin-api-express | adhd | ts | [--L-] | skip | — | Parameter-driven server, shared logger |
| dust | scratch | py | [---D] | skip | G3 | Non-Node language |
| claude-metadata | scratch | js | [E---] | skip | — | Reads Claude Code settings, not @adhd scope |
| photo-atlas | scratch | py | [---D] | skip | G3 | Non-Node language |
| @adhd/cdp-connection | scratch | ts | [-F--] | candidate | — | Reads CHROME_PATH env + runtime state |
