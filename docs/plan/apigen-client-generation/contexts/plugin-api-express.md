# plugin-api-express — IMPLEMENT @adhd/apigen-plugin-api-express

**Phase:** plugins · **Depends on:** audit-runtime · **Parallel with:** plugin-mcp, plugin-jsonschema, plugin-api-fastify, plugin-cli-output · **Guard:** `npx --yes nx test apigen-plugin-api-express`

---

## Goal

Implement the Express HTTP API plugin. Mechanically similar to `plugin-api-fastify` — same route shape (`POST /<packageId>/<fnName>`), same dispatch pattern, different framework. `generate()` emits `routes.ts` using an Express `Router`; `run()` spins up an Express app in-process.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/plugins/api-express/src/lib/` — adapts Fastify patterns to Express Router.
- **Reference Pattern:** Same pattern as `plugin-api-fastify`. Read `~/dev/projects/reverse-apis/apps/adhd-reverse-apis/src/app/routes/api.ts` for the dispatch shape. Express uses `Router`, `res.json(result)` instead of returning from the handler. The Express surface (`express()`, `express.json()`, `Router`, `router.post`, `app.listen`/`server.close`) is the vendored contract `[iface:express]` (see `interfaces.json`).
- **Delta Spec:**

### Install dependency

```json
{ "dependencies": { "express": "^4.18.0" }, "devDependencies": { "@types/express": "^4.17.0" } }
```

### `generate.ts`

Emits `routes.ts` with Express Router:

```typescript
// Generated routes.ts template:
// import { Router } from 'express'
// import { dispatch } from '@adhd/apigen-runtime'
// import * as <id>_fns from '<importPath>'
//
// const router = Router()
// const schemas = { ... }
//
// router.post('/<id>/<fnName>', async (req, res) => {
//   const { data = {}, ...envelope } = req.body
//   const result = await dispatch(<id>_fns, undefined, schemas['<id>:<fnName>'], '<fnName>', envelope, data)
//   res.json(result)
// })
//
// export default router
```

### `run.ts`

```typescript
import express from 'express'
import { dispatch } from '@adhd/apigen-runtime'
// ... same pattern as fastify run.ts but using express app.use(express.json()) + router.post()
```

### optionsSchema

Same as fastify: `port` (default 3000), `routePrefix` (default '').

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/plugins/api-express/src/lib/plugin.ts",
            "packages/apigen/plugins/api-express/src/lib/generate.ts",
            "packages/apigen/plugins/api-express/src/lib/run.ts",
            "packages/apigen/plugins/api-express/src/index.ts",
            "packages/apigen/plugins/api-express/src/test/plugin.spec.ts",
            "package.json"]
read_only:  []
```

---

## Acceptance criteria

- `[plugin-api-express.1]` `generate()` emits `routes.ts` using `Router` from `express`.
- `[plugin-api-express.2]` Generated `routes.ts` imports `dispatch` from `@adhd/apigen-runtime`.
- `[plugin-api-express.3]` `run()` responds to `POST /test-pkg/getUser` with correct JSON (use supertest).
- `[plugin-api-express.4]` Route shape is identical to fastify: `POST /<packageId>/<fnName>`, body `{ data?, ...envelope }`.

---

## Commit points

1. After tests pass: `feat(apigen-plugin-api-express): implement Express HTTP plugin — generate + run`
