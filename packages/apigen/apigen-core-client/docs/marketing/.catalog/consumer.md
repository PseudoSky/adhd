# Consumer Test — @adhd/apigen-core-client

## Run 1 — 2026-07-02T22:35:00-05:00

### Task 1: Extract operations from a TypeScript file
**Outcome: COMPLETED_DOC_ONLY**

Docs sufficient. `extract({ sourceFile, namespace })` found in README quickstart and docs/reference/extract.md. All Operation fields documented in descriptor.md. No source-code lookup needed.

### Task 2: Compose schemas with middleware
**Outcome: PARTIAL**

Core workflow documented. Two issues:
1. No explicit type name for middleware objects (`SlimMiddleware` — not exported from package). User must infer shape from examples.
2. Two-middleware-with-override output not shown. User derived `ping.input.required = ['session', 'data']` from invariants, but no explicit example confirmed this.

**Reader-searches triggered:** 1 — wanted to verify the middleware object shape in source.

### Task 3: Build a v2 logging plugin
**Outcome: COMPLETED_DOC_ONLY**

Exact match in docs/how-to/building-plugins.md. All types (`Plugin`, `Call`, `Next`, `Result`) documented. `satisfies Plugin` pattern shown. No guessing needed.

### Third gap found
`Operation.namespace` is `Segment` but `ExtractOptions.namespace` is `string`. User wondered how string→Segment conversion happens. No doc explained it.

### Summary
- **2 tasks COMPLETED_DOC_ONLY**
- **1 task PARTIAL**
- **1 reader-search triggered**
