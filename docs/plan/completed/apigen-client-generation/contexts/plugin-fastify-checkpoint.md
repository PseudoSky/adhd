# plugin-fastify-checkpoint — HUMAN REVIEW GATE

**Phase:** plugins · **Depends on:** plugin-api-fastify · **Guard:** `test -f docs/plan/apigen-client-generation/checkpoints/fastify-approved.md`

---

## Purpose

This is a **mandatory human checkpoint**. The executor must stop here and await review from the plan owner before the remaining 4 plugins are implemented.

**Rationale:** `plugin-api-fastify` is the reference implementation — the first real plugin built after scaffolding. It establishes the patterns that all other plugins follow (dispatch import, route shape, run/generate split, no AJV body schema). If the fastify plugin has a structural problem (wrong dispatch call, wrong route shape, wrong OutputPlugin interface usage), catching it here prevents the same mistake from being repeated in 4 more plugins.

---

## What the executor does here

1. **Verify all fastify tests pass:**
   ```bash
   npx --yes nx test apigen-plugin-api-fastify
   ```
   Expected: 0 failures.

2. **Verify integration tests pass for fastify (HTTP round-trip):**
   ```bash
   npx --yes nx test apigen-cli --testPathPattern=integration/http
   ```
   Expected: Fastify `POST /real-api/getUser` returns `{id:'abc',name:'Alice',role:'user'}`.

3. **Verify dispatch is not inlined:**
   ```bash
   grep -n "dispatch" packages/apigen/plugins/api-fastify/src/lib/run.ts | grep -v "import\|from"
   # Expected: no output
   ```

4. **Verify no AJV body schema in routes:**
   ```bash
   grep -rn "schema.*body\|body.*schema" packages/apigen/plugins/api-fastify/src/
   # Expected: no output
   ```

5. **Stop.** Do not advance to `plugin-mcp`, `plugin-jsonschema`, `plugin-api-express`, or `plugin-cli-output`. Wait for human approval.

6. **Present to plan owner** with this summary:
   - fastify test results (pass/fail count)
   - integration/http test results
   - generated `routes.ts` snippet (first 30 lines) for visual inspection
   - `plugin.ts` (full) for interface conformance review

7. **After plan owner confirms:** Create the approval file:
   ```bash
   mkdir -p docs/plan/apigen-client-generation/checkpoints
   cat > docs/plan/apigen-client-generation/checkpoints/fastify-approved.md << 'EOF'
   # Fastify Plugin — Approved

   Approval recorded by plan owner. The `plugin-api-fastify` reference implementation
   is structurally correct. Proceed with remaining 4 plugins.

   Verified:
   - [ ] All unit tests pass
   - [ ] HTTP integration test passes (POST /real-api/getUser)
   - [ ] dispatch imported from @adhd/apigen-runtime, not inlined
   - [ ] No AJV body schema in route registration
   - [ ] OutputPlugin interface correctly satisfied
   - [ ] generate() + run() split is clean

   Approved: <date>
   EOF
   ```

8. **Commit the approval file:**
   ```bash
   git add docs/plan/apigen-client-generation/checkpoints/fastify-approved.md
   git commit -m "chore(apigen): approve fastify reference plugin — proceed to remaining plugins"
   ```

---

## What the plan owner reviews

- The `plugin.ts` + `generate.ts` + `run.ts` files in `packages/apigen/plugins/api-fastify/src/lib/`
- The integration test output from `integration/http.spec.ts`
- That the route shape `POST /<packageId>/<fnName>` is correct
- That `dispatch` is cleanly imported and used, not duplicated
- That `generate()` emits correct TypeScript in `routes.ts`
- That the fastify plugin would serve as a valid model for express, mcp, and cli-output implementors

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["docs/plan/apigen-client-generation/checkpoints/fastify-approved.md"]
read_only:  ["packages/apigen/plugins/api-fastify/"]
```

---

## Acceptance criteria

- `[plugin-fastify-checkpoint.1]` `docs/plan/apigen-client-generation/checkpoints/fastify-approved.md` exists:
  ```bash
  test -f docs/plan/apigen-client-generation/checkpoints/fastify-approved.md
  ```
  This file is ONLY created after explicit human approval. The guard on this state therefore cannot auto-pass — it requires human action.

---

## Commit points

1. Approval file committed (by executor, after owner confirms): `chore(apigen): approve fastify reference plugin — proceed to remaining plugins`
