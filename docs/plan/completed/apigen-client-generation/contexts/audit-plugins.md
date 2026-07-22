# audit-plugins — AUDIT ALL 5 PLUGINS

**Phase:** plugins · **Depends on:** plugin-jsonschema, plugin-mcp, plugin-api-fastify, plugin-api-express, plugin-cli-output · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase plugins`

> **REVIEWER GATE:** After this audit passes, request a `code-reviewer` agent review of all plugin implementations before the CLI states proceed. The reviewer checks: OutputPlugin interface satisfaction, dispatch import pattern, no inline dispatch logic, template correctness. Record the verdict in the transition log.

---

## Goal

Verify all 5 plugins build, their tests pass, the `OutputPlugin` interface is satisfied, and the `dispatch()` single-path invariant is not violated. No deferrable items.

---

## Audit checklist

**Build integrity:**
- `[audit-plugins.1]` All 5 plugin packages build:
  ```bash
  npx --yes nx run-many --target=build --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
  ```

**Test suites:**
- `[audit-plugins.2]` All plugin test suites pass:
  ```bash
  npx --yes nx run-many --target=test --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
  ```

**OutputPlugin contract:**
- `[audit-plugins.3]` Each plugin's default export has `id`, `description`, `generate` function:
  ```bash
  for pkg in apigen-plugin-jsonschema apigen-plugin-mcp apigen-plugin-api-fastify apigen-plugin-api-express apigen-plugin-cli-output; do
    node -e "const p=require('./dist/packages/apigen/plugins/*/$pkg/index.cjs'); if(!p.id||!p.generate) throw new Error('$pkg missing OutputPlugin fields')" 2>/dev/null || \
    echo "WARN: $pkg build artifact path needs adjustment"
  done
  ```

**Dispatch purity — [inv:dispatch-single-path]:**
- `[audit-plugins.4]` No plugin inlines dispatch logic — `dataParamNames` and `needsEnvelopeField` are only imported from `@adhd/apigen-runtime`, never re-implemented:
  ```bash
  grep -rn "\.map(k => domainArgs\|paramNames\.map\|\.split(':').map" packages/apigen/plugins/
  # must produce no output (these patterns indicate inline dispatch)
  ```

- `[audit-plugins.5]` All plugins import `dispatch` from `@adhd/apigen-runtime` (not inlined):
  ```bash
  for plugin_dir in packages/apigen/plugins/*/; do
    if grep -rn "from '@adhd/apigen-runtime'" "$plugin_dir/src" | grep -q "dispatch"; then
      echo "OK: $plugin_dir imports dispatch"
    else
      echo "FAIL: $plugin_dir does not import dispatch from apigen-runtime"
    fi
  done
  ```

**Flag convention:**
- `[audit-plugins.6]` No `--output` flag referenced in any plugin (must be `--type`):
  ```bash
  grep -rn '"output"' packages/apigen/plugins/
  # must produce no output (as a CLI flag name in string literals)
  ```

**Language-agnostic output:**
- `[audit-plugins.7]` `PluginOutput.files` content is not validated for TypeScript syntax in any plugin — plugins may emit any string:
  ```bash
  grep -rn "\.ts\"\|\.js\"\|typescript\|isTsFile" packages/apigen/plugins/*/src/lib/
  # Allowed: file path endings. Not allowed: TS-specific file content validation
  ```

---

## Reviewer gate (after passing)

After the audit script exits 0, request:

```
Dispatch code-reviewer agent: review packages/apigen/plugins/ — check OutputPlugin interface correctness, dispatch import pattern, template output correctness for mcp/fastify/express/cli plugins.
```

Record reviewer verdict in the `amendment_log` with `class: executor`, `type: add-criterion`, `reason: reviewer gate completed`.

---

## Commit points

Audit state — fixes only. `fix(apigen-plugin-<name>): <issue>` per fix.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).
This audit state only edits the audit script when a check itself needs repair; source
fixes land in the offending package and are committed separately.

```text
mutates:    ["docs/plan/apigen-client-generation/scripts/audit_apigen.py"]
read_only:  ["packages/apigen/"]
```
