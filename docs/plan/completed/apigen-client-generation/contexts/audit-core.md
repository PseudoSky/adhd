# audit-core — AUDIT @adhd/apigen-core

**Phase:** foundation · **Depends on:** schema-extraction, schema-composition · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase foundation`

---

## Goal

Verify that `@adhd/apigen-core` is complete and correct before the runtime and plugin phases build on top of it. No deferrable items — every failing check is fixed here.

---

## Audit checklist

The audit script runs these checks. All must exit 0.

**Build integrity:**
- `[audit-core.1]` `npx --yes nx build apigen-core` exits 0.
- `[audit-core.2]` No TypeScript compilation errors in `packages/apigen/core/src/`.

**Contract completeness:**
- `[audit-core.3]` `packages/apigen/core/src/index.ts` exports all 8 symbols: `generateSchemas`, `composeSchemas`, `GeneratedSchemas`, `ComposedSchemas`, `ExportMode`, `GenerateSchemasOptions`, `OutputPlugin`, `PluginInput`.
- `[audit-core.4]` `generateSchemas` stub is replaced — import of real implementation (not throwing 'not implemented'):
  ```bash
  grep -n "not implemented" packages/apigen/core/src/index.ts
  # must produce no output
  ```

**Behavioral contracts:**
- `[audit-core.5]` All `generate-schemas.spec.ts` tests pass (criterion `[schema-extraction.1]` through `[schema-extraction.7]`).
- `[audit-core.6]` All `compose-schemas.spec.ts` tests pass (criterion `[schema-composition.1]` through `[schema-composition.5]`).

**Isolation:**
- `[audit-core.7]` No import of `@adhd/apigen-runtime` or `@adhd/apigen-plugin-*` in core:
  ```bash
  grep -rn "@adhd/apigen-runtime\|@adhd/apigen-plugin" packages/apigen/core/src/
  # must produce no output
  ```
- `[audit-core.8]` No circular imports (tsc would error; also check for any `require()` of sibling packages).

**Key decisions locked:**
- `[audit-core.9]` `ctx` filter is by name only — no type-check in extractor:
  ```bash
  grep -n "getType\|TypeChecker" packages/apigen/core/src/lib/generate-schemas.ts packages/apigen/core/src/lib/extractors/*.ts
  # must produce no output (type checking on ctx would be a violation)
  ```
- `[audit-core.10]` `data:{}` wrapper is present in zero-param composed schema:
  ```bash
  npx --yes nx test apigen-core --reporter=verbose 2>&1 | grep "zero-param\|data.*always"
  ```

---

## Commit points

This is an audit state — no new code is written. If a check fails, fix the source file and commit with `fix(apigen-core): <what was wrong>`. List every fix in the transition log.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).
This audit state only edits the audit script when a check itself needs repair; source
fixes land in the offending package and are committed separately.

```text
mutates:    ["docs/plan/apigen-client-generation/scripts/audit_apigen.py"]
read_only:  ["packages/apigen/"]
```
