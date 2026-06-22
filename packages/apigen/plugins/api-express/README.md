# @adhd/apigen-plugin-api-express

apigen target plugin (`--type api-express`) — exposes a source file's exports as an
**Express HTTP API**. One `POST /<namespace>/<fn>` route per export (handlers call
`res.json(result)`). Generates `routes.ts` to disk *and* runs a live server.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

apigen run      --source ./api.ts --type api-express --namespace api --opt port=3000
apigen generate --source ./api.ts --type api-express --out-dir ./out    # → out/routes.ts

curl -X POST http://127.0.0.1:3000/api/getUser \
  -H 'content-type: application/json' -d '{"data":{"userId":"abc"}}'
```

`--opt` keys: `port` (`3000`), `host` (`127.0.0.1`), `routePrefix` (`""`). Method must be
uppercase `POST`; arguments are wrapped in `{"data":{…}}` (the request envelope).
