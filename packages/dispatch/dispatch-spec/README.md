# @adhd/dispatch-spec

TypeScript types, JSON Schema documents, cross-language structural validators,
and operation vocabulary for the dispatch plan ecosystem.

```bash
npm install @adhd/dispatch-spec
```

---

## Design tenets

### 1. Shape ops are the specification

The `shape.ops[]` array on every operation is simultaneously a **prompt** for
generative agents, a **verification contract** for gitnexus post-execution AST
checks, and a **machine-execution spec** for future AST-based tool-call
executors. Every `add-field`, `add-param`, and `set-key` carries an exact type
in `to` — never `null`. An automated transformer can produce correct output
from shape ops alone, with no LLM required (D-05).

### 2. Cost optimization is structural, not heuristic

Every dispatch costs a fixed base overhead (B), reads source files (Sᵢ), and
produces output tokens (Kᵢ). The optimizer computes the **minimum total token
cost** across all three components, respecting DAG precedence and context-window
quality cliffs. This is an NP-hard problem that admits polynomial special
cases. The optimizer's batch assignment pays back the planning cost on its first
execution wave (SCOPE.md §A1–A4).

### 3. Agents never read dag.json raw

This package defines the data contract that every consumer — human CLI, MCP
server, orchestrator, Python validator — agrees on. Agents interact with
dag.json through typed tools (`dag.milestone_add`, `dag.pending_clear`) that
enforce structural validity, referential integrity, and per-kind operation
constraints. No agent context window ever contains raw dag.json text (D-02).

### 4. Operational fidelity

Every milestone carries a **guard** — a pinned shell command that proves
completion. Every operation carries a **shape** — a structural spec that
describes exactly what changes, with what types, at what location. A plan that
passes its guards with its shapes verified by gitnexus is a plan that actually
worked, not a plan that an agent _thinks_ worked (D-05, D-12).

### 5. Cross-language by design

TypeScript types are the canonical representation, but this package ships
**JSON Schema** (`dag-v4.schema.json`) and a **per-kind operation vocabulary
mapping** (`valid-ops-by-kind.json`) as plain JSON data. A Python orchestrator
can validate a dag.json with `jsonschema` and constrain tool inputs with
`op in mapping[kind]`. No npm install needed.

### 6. Plans are reusable, execution is amortized

A plan is authored once. Its shape ops, guards, and dependencies are committed
to git. The orchestrator replays it as many times as needed — across different
repos, different model tiers, different provider backends. The one-time planning
token cost is amortized over every execution. The optimizer's savings compound.

---

## Exports

| Export                | Purpose                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `types`               | `DagJson`, `DagSnapshot`, `DispatchUnit`, `OperationDag`, `Shape`, `MilestoneSnapshot`, all sub-types |
| `validateDagJson`     | Structural + cycle + ref integrity + op/kind constraint validation                                    |
| `validateSnapshot`    | D-07 eligibility invariant + status/wave/ref validation                                               |
| `assertValidDagJson`  | Throwing variant — narrows type to `DagJson`                                                          |
| `assertValidSnapshot` | Throwing variant — narrows to `DagSnapshot`                                                           |
| `migrateDag`          | `(from, to, dag) → void` — sequential v2→v3→v4 schema upgrades                                        |
| `VALID_OPS_BY_KIND`   | `Record<string, ReadonlySet<ShapeOpType>>`                                                            |
| `isValidOpForKind`    | `(kind, op) → boolean` — runtime check                                                                |
| `WRITE_CLASS_ACTIONS` | `ReadonlySet<OperationAction>`                                                                        |
| `IOptimizerDeps`      | Interface for optimizer dependency injection                                                          |

### JSON files shipped in dist

| File                     | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `dag-v4.schema.json`     | Full JSON Schema for dag.json — 18 top-level properties |
| `valid-ops-by-kind.json` | 13 kind entries mapping `shape.kind` → allowed ops      |

## Zero dependencies

This package imports nothing but TypeScript. No filesystem, no node APIs, no
third-party libs. `platform:shared` — safe in browser, server, and CLI contexts.
