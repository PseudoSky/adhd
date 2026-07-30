# doc-conformance: dispatch-cli

## Recalled Ideal Doc Set (entrypoint:cli with apigen triple-transport)

Per memory recall for entrypoint packages:
1. **README.md** (top-level, 3-5 min read)
2. **SPEC.md** (full contract reference: every operation's input/output schema)
3. **DESIGN.md** (architecture decisions)
4. **CHANGELOG.md** (per-package, conventional commits)
5. **skill/SKILL.md** (MCP-entrypoint only; inapplicable here — dispatch-cli is CLI-only, not MCP)

## Existing Doc Surface

| Doc | Path | Size | Status | Issues |
|-----|------|------|--------|--------|
| README.md | `entrypoint/dispatch-cli/README.md` | 119 lines | Present | See analysis below |
| CHANGELOG.md | `entrypoint/dispatch-cli/CHANGELOG.md` | 57 lines | Present | Minimal — version bumps only, no feature documentation |
| package.json description | `entrypoint/dispatch-cli/package.json` | 1 line | Present | Partial — one-line description |
| SPEC.md | `entrypoint/dispatch-cli/` | — | **MISSING** | No formal operation-level contract doc |
| DESIGN.md | `entrypoint/dispatch-cli/` | — | **MISSING** | No architecture decisions doc |
| docs/ directory | `entrypoint/dispatch-cli/docs/` | — | **MISSING** | No docs/ directory exists |

## README.md Analysis

The README is comprehensive and well-maintained. Cover-to-cover assessment:

### Coverage

| Section | Present? | Quality | Issues |
|---------|----------|---------|--------|
| Brief description / problem | ✅ Yes | Good | — |
| Commands table (all 7) | ✅ Yes | Good | — |
| Build instructions | ✅ Yes | Good | — |
| Test instructions | ✅ Yes | Good | — |
| Paid boundary disclosure | ✅ Yes | Excellent | — |
| Live e2e gate documentation | ✅ Yes | Excellent | Named owner, env gate, cost disclosure all present |
| Architecture (apigen-generated vs hand-written) | ✅ Yes | Excellent | Two-CLI-router architecture is clearly explained |

### Issues Found

| # | Issue | Type | Location | Rationale |
|---|-------|------|----------|-----------|
| 1 | **Stale path references** | `INCORRECT` | README.md:85-86 | References `packages/dispatch/dispatch-cli/src/test/integration/real-e2e.ts` and `packages/dispatch/dispatch-cli/bin/cli.ts` — but the package lives at `entrypoint/dispatch-cli/`, not `packages/dispatch/dispatch-cli/`. These paths are wrong. The CLI generation path at line 25 references `dist/packages/dispatch/dispatch-cli/cli/cli.ts` when the actual generated artifact is at `dist/entrypoint/dispatch-cli/cli/cli.ts`. |
| 2 | **No SPEC.md** | `UNDOCUMENTED` | Missing | The README is the only documentation. There is no formal operation contract (input/output schemas, error codes, status transitions). Every operation's parameter documentation lives only in JSDoc comments in `api.ts`. |
| 3 | **No DESIGN.md** | `UNDOCUMENTED` | Missing | The architectural decisions (why `core.ts` exists as the DI'd implementation behind `api.ts`, why the hand-written fallback exists, why apigen-generated CLI is partially broken, why Commander vs apigen for boolean flags) are scattered across JSDoc headers, not collected in one place. |
| 4 | **Minimal CHANGELOG.md** | `REDUNDANT` | CHANGELOG.md | 57 lines but only version-bump boilerplate — no feature descriptions, no bug-fix details, no migration notes. Version 0.0.2 and 0.0.3 have identical entries. |
| 5 | **--help no-output issue** | `CONFUSING` | (Known issue) | The `--help produces no output` issue mentioned in the task description was tested: `bin/cli.ts --help` DOES produce output (captured above). This issue may affect the apigen-generated CLI when imported as a library, or may be stale. Either way the hand-written CLI's `--help` works. |

## Doc Proportions

| Category | Count | Notes |
|----------|-------|-------|
| JUNK | 1 | Stale path references (README.md) |
| REDUNDANT | 1 | CHANGELOG.md (identical 0.0.2/0.0.3 entries) |
| UNDOCUMENTED | 2 | SPEC.md, DESIGN.md |
| Total docs | 3 | README.md, CHANGELOG.md, package.json description |

Coverage ratio of ideal doc set: **2 of 5 required docs present** (40%). README is present and high-quality; CHANGELOG exists but is minimal.

## Recommendations

| Doc | Action | Rationale |
|-----|--------|-----------|
| README.md | `REVISE` | Fix stale path references (`packages/dispatch/` → `entrypoint/`) |
| CHANGELOG.md | `KEEP` (add content on next release) | Structure is correct; content is minimal but usable |
| SPEC.md | `CREATE` | Document the 7 operations with input/output schemas, error codes, status transitions |
| DESIGN.md | `CREATE` | Collect architecture decisions: core.ts vs api.ts split, two-CLI-router strategy, Commander vs apigen for boolean flags, paid boundary design |
| docs/ directory | `CREATE` | New docs go under `entrypoint/dispatch-cli/docs/` |

## Orphans

None found — the README accurately represents the shipped capabilities without extraneous information. The stale paths are errors (not orphans) that need correction.
