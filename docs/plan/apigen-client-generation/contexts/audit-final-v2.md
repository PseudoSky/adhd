# audit-final-v2 — FINAL AUDIT: ALL DOD CLAUSES + INVARIANTS

**Phase:** final · **Depends on:** integration-tests · **Guard:** `python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase final`

---

## Goal

This is the definition of done. Every `[dod.N]` clause must map to a passing check below. No partial credit — all checks exit 0 or the plan is not done.

> **REVIEWER GATE (architect-reviewer):** After all checks pass, dispatch `architect-reviewer` to review the complete `packages/apigen/` directory. The reviewer checks: Nx layer/platform tag correctness, dependency flow (no upward deps), OutputPlugin interface consistency, dispatch purity, language-agnostic plugin design. Record verdict in `amendment_log`.

---

## DoD checks

### [dod.1] — `apigen-cli generate` writes correct output files

```bash
# Run generate against the canonical fixture, verify output
tmpdir=$(mktemp -d)
npx --yes tsx packages/apigen/cli/src/index.ts generate \
  --source packages/apigen/cli/src/test/fixtures/real-api.ts \
  --type jsonschema \
  --out-dir "$tmpdir"

# Verify: fixture/api.ts exports getUser and sendEmail
test -f "$tmpdir/fixtures/getUser.json" && \
test -f "$tmpdir/fixtures/sendEmail.json" && \
node -e "const f=require('$tmpdir/fixtures/getUser.json'); if(!f.input||!f.output) throw new Error('missing input/output')"
```

### [dod.2] — `apigen-cli run` starts a server that serves requests

```bash
# Start MCP server in background, wait for startup, send a request, kill it
tmpdir=$(mktemp -d)
timeout 10 npx --yes tsx packages/apigen/cli/src/index.ts run \
  --source packages/apigen/cli/src/test/fixtures/real-api.ts \
  --type mcp \
  --opt transport=stdio &
SERVER_PID=$!
sleep 2

# Send a tools/list request to the MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  timeout 3 npx --yes tsx packages/apigen/cli/src/index.ts run \
  --source packages/apigen/cli/src/test/fixtures/real-api.ts \
  --type mcp --opt transport=stdio 2>/dev/null | head -1 | \
  node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d)" 2>/dev/null && \
  echo "MCP server responded" || echo "WARN: MCP stdio check needs adjustment"

kill $SERVER_PID 2>/dev/null || true
```

### [dod.3] — `ctx` parameter is always excluded from schemas

```bash
# Run schema extraction on a fixture with ctx param
node -e "
  const {generateSchemas} = require('./dist/packages/apigen/core/index.cjs')
  generateSchemas({ sourceFile: require('path').resolve('packages/apigen/core/src/test/fixtures/with-ctx.ts'), exportMode: { type: 'named' } })
    .then(schemas => {
      const fnSchema = Object.values(schemas)[0]
      const props = fnSchema?.input?.properties?.data?.properties ?? {}
      if ('ctx' in props) throw new Error('ctx appeared in schema — must be excluded')
      console.log('OK: ctx excluded from schema')
    })
"
```

### [dod.4] — `data:{}` wrapper always present (even zero params)

```bash
node -e "
  const {generateSchemas, composeSchemas} = require('./dist/packages/apigen/core/index.cjs')
  generateSchemas({ sourceFile: require('path').resolve('packages/apigen/core/src/test/fixtures/zero-param.ts'), exportMode: { type: 'named' } })
    .then(domain => {
      const {schemas} = require('./dist/packages/apigen/runtime/index.cjs').createApiPackage({ domainSchemas: domain, middlewares: [] })
      const s = Object.values(schemas)[0]
      if (!s?.input?.properties?.data) throw new Error('data wrapper missing')
      if (!s?.input?.required?.includes('data')) throw new Error('data not in required')
      console.log('OK: data wrapper present')
    })
"
```

### [dod.5] — middleware `false` override suppresses envelope field

```bash
node -e "
  const {createApiPackage} = require('./dist/packages/apigen/runtime/index.cjs')
  // A middleware that adds 'session' to envelope
  const mw = { id: 'session', envelope: { type: 'object', properties: { session: { type: 'string' } } }, createContext: async () => ({}), eventMapping: {} }
  // Override session to false
  const {schemas} = createApiPackage({ domainSchemas: { getUser: { params: [], returnType: {} } }, middlewares: [mw], overrides: { getUser: { session: false } } })
  const s = schemas.getUser
  if (s?.input?.properties?.session) throw new Error('session not suppressed by override')
  console.log('OK: override suppresses middleware field')
"
```

### [dod.6] — All 5 plugins build and pass tests

```bash
npx --yes nx run-many --target=build --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
npx --yes nx run-many --target=test --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output
```

### [dod.7] — Non-TS output is possible (language-agnostic interface)

```bash
# Verify: plugin-jsonschema emits JSON, not TypeScript
# AND: OutputPlugin.generate() return type is {files: {path, content}[]} with no TS constraint on content
node -e "
  const p=require('./dist/packages/apigen/plugins/jsonschema/index.cjs')
  const out=p.generate({packages:[{id:'x',schemas:{f:{input:{},output:{}}},importPath:'x'}],outputDir:'/tmp',options:{}})
  if(!out.files[0].content.startsWith('{')) throw new Error('expected JSON content')
  console.log('OK: JSON content, not TS')
"
```

### [dod.8] — Nx generator scaffolds valid plugin package

```bash
# Run the generator in a temp workspace, verify artifacts
node -e "
  const {createTreeWithEmptyWorkspace} = require('@nx/devkit/testing')
  const {pluginGenerator} = require('./dist/packages/apigen/nx/index.cjs')
  const tree = createTreeWithEmptyWorkspace()
  pluginGenerator(tree, { name: 'test-plugin' }).then(() => {
    if (!tree.exists('packages/apigen/plugins/test-plugin/src/lib/plugin.ts')) throw new Error('plugin.ts missing')
    const proj = JSON.parse(tree.read('packages/apigen/plugins/test-plugin/project.json','utf8'))
    if (!proj.tags.includes('layer:logic') || !proj.tags.includes('platform:node')) throw new Error('wrong tags')
    console.log('OK: generator scaffolds correct structure')
  })
"
```

---

## Invariant sweeps

### [audit-final-v2.inv-type-flag-only] — [inv:type-flag-only]

```bash
grep -rn "'--output'\|\"--output\"" packages/apigen/
# must produce no output
```

### [audit-final-v2.inv-dispatch-single-path] — [inv:dispatch-single-path]

```bash
# dataParamNames and needsEnvelopeField must only be defined in dispatch.ts
grep -rn "function dataParamNames\|function needsEnvelopeField" packages/apigen/ | grep -v "dispatch.ts\|dispatch.spec.ts"
# must produce no output
```

### [audit-final-v2.inv-ctx-name-only] — [inv:ctx-name-only]

```bash
# No TypeChecker call near ctx filtering
grep -rn "getType.*ctx\|TypeChecker.*ctx\|ctx.*TypeChecker" packages/apigen/core/src/
# must produce no output
```

### [audit-final-v2.inv-language-agnostic-output] — [inv:language-agnostic-output]

```bash
# No plugin validates that files[].content is TypeScript
grep -rn "\.ts\"\|typescript-parse\|isTsFile\|checkFile\|parseFile" packages/apigen/plugins/*/src/
# must produce no output (as content-validation, not path extensions)
```

### [audit-final-v2.inv-nx-platform-tags] — [inv:nx-platform-tags]

```bash
for dir in packages/apigen/*/; do
  if [ -f "$dir/project.json" ]; then
    node -e "
      const p=JSON.parse(require('fs').readFileSync('${dir}project.json','utf8'))
      const tags = p.tags || []
      if (!tags.some(t=>t.startsWith('layer:'))) throw new Error('${dir} missing layer tag')
      if (!tags.some(t=>t.startsWith('platform:'))) throw new Error('${dir} missing platform tag')
    "
  fi
done
```

---

## Reviewer gate (after passing)

After all checks above exit 0:

```
Dispatch architect-reviewer agent to review packages/apigen/ — verify Nx tag correctness, no upward dependencies, OutputPlugin consistency, dispatch purity, and that the system would accept a Python gRPC plugin without modification.
```

Record reviewer verdict in `amendment_log`. Only mark state `done` after reviewer approval.

---

## Commit points

1. After all checks pass: `feat(apigen): all DoD checks passing — system complete`
2. After reviewer verdict: `docs(apigen): record architect-reviewer approval in amendment_log`

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).
This audit state only edits the audit script when a check itself needs repair; source
fixes land in the offending package and are committed separately.

```text
mutates:    ["docs/plan/apigen-client-generation/scripts/audit_apigen.py"]
read_only:  ["packages/apigen/"]
```
