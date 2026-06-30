# @adhd/dispatch-spec

TypeScript types, JSON Schema documents, cross-language structural validators,
and operation vocabulary for the dispatch plan ecosystem.

```bash
npm install @adhd/dispatch-spec
```

## Exports

- **types** — `DagJson`, `DagSnapshot`, `DispatchUnit`, `OperationDag`, `Shape`, all sub-types
- **validate** — `validateDagJson()`, `validateSnapshot()` — structural + D-07 invariant checks
- **migrate** — `migrateDag(fromVersion, toVersion, dag)` — schema version upgrade
- **VALID_OPS_BY_KIND** — per-kind operation vocabulary for cross-language consumers
- **JSON Schema** — `dag-v4.schema.json`, `valid-ops-by-kind.json`

## Zero dependencies

This package imports nothing but TypeScript. Safe in browser, server, and CLI contexts.
