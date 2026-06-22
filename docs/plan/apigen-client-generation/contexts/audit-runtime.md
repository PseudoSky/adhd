# audit-runtime — AUDIT @adhd/apigen-runtime

**Phase:** runtime · **Depends on:** runtime-middleware, runtime-dispatch · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase runtime`

---

## Goal

Verify that `@adhd/apigen-runtime` is complete and correct before the plugin phase. No deferrable items.

---

## Audit checklist

**Build integrity:**
- `[audit-runtime.1]` `npx --yes nx build apigen-runtime` exits 0.

**Export completeness:**
- `[audit-runtime.2]` `packages/apigen/runtime/src/index.ts` exports all required symbols: `defineMiddleware`, `EventBus`, `wireObservers`, `buildContext`, `assertNoSelfSubscription`, `createApiPackage`, `needsEnvelopeField`, `dataParamNames`, `dispatch`, `ConfigurationError`.
- `[audit-runtime.3]` Dispatch utilities are exported — no plugin can import them from anywhere else:
  ```bash
  node -e "const r=require('./dist/packages/apigen/runtime/index.cjs'); ['needsEnvelopeField','dataParamNames','dispatch'].forEach(k=>{ if(typeof r[k]!=='function') throw new Error('missing: '+k) })"
  ```

**Behavioral contracts:**
- `[audit-runtime.4]` All `api-package.spec.ts` tests pass.
- `[audit-runtime.5]` All `build-context.spec.ts` tests pass.
- `[audit-runtime.6]` All `dispatch.spec.ts` tests pass.

**Isolation:**
- `[audit-runtime.7]` `@adhd/apigen-runtime` does NOT import from `@adhd/apigen-plugin-*`:
  ```bash
  grep -rn "@adhd/apigen-plugin" packages/apigen/runtime/src/
  # must produce no output
  ```
- `[audit-runtime.8]` No Node-only built-in APIs (`fs`, `path`, `child_process`) imported in runtime:
  ```bash
  grep -rn "from 'fs'\|from 'path'\|from 'child_process'\|require('fs')" packages/apigen/runtime/src/
  # must produce no output
  ```

**Key decision locked:**
- `[audit-runtime.9]` `dispatch()` is the single canonical path — it's not duplicated anywhere in `apigen-runtime`:
  ```bash
  # All dispatch-shaped code should be in dispatch.ts only
  grep -rn "dataParamNames\|needsEnvelopeField" packages/apigen/runtime/src/lib/ | grep -v "dispatch.ts\|dispatch.spec.ts"
  # must produce no output
  ```

---

## Commit points

Audit state — no new code. Fixes committed as `fix(apigen-runtime): <issue>` with transition log entries.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).
This audit state only edits the audit script when a check itself needs repair; source
fixes land in the offending package and are committed separately.

```text
mutates:    ["docs/plan/apigen-client-generation/scripts/audit_apigen.py"]
read_only:  ["packages/apigen/"]
```
