# @adhd/apigen-plugin-api-fastify

apigen target plugin (`--type api-fastify`) — exposes a source file's exports as a
**Fastify HTTP API**. One `POST /<namespace>/<fn>` route per export. Generates `routes.ts`
to disk *and* runs a live server.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

apigen run      --source ./api.ts --type api-fastify --namespace api --opt port=3000
apigen generate --source ./api.ts --type api-fastify --out-dir ./out   # → out/routes.ts

curl -X POST http://127.0.0.1:3000/api/getUser \
  -H 'content-type: application/json' -d '{"data":{"userId":"abc"}}'
```

`--opt` keys: `port` (`3000`), `host` (`127.0.0.1`), `routePrefix` (`""`). Method must be
uppercase `POST`; arguments are wrapped in `{"data":{…}}` (the request envelope).
