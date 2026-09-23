# Backlog CLI — Demo Fixture (canonical dataset)

There is no bulk-import command in the shipped surface (see `../UNRESOLVED.md` U12: no
`admin` verb, no `import` action). This dataset is instead expressed as the exact
`create`/`upsert-*` calls that reproduce it. Run each line verbatim, in order, under a
scratch `--sandbox` store (see `../README.md`); every call below was verified against
`entrypoint/backlog/dist/index.js`.

```bash
export ADHD_ROOT="$(pwd)/tmp/backlog-demo"
BIN="node entrypoint/backlog/dist/index.js --sandbox"

# Projects
$BIN backlog upsert-project --input '{"name":"adhd","by":"demo-agent"}'
$BIN backlog upsert-project --input '{"name":"sox-ecosystem","by":"demo-agent"}'

# Components
$BIN backlog upsert-component --input '{"project":"adhd","name":"backlog","by":"demo-agent"}'
$BIN backlog upsert-component --input '{"project":"adhd","name":"ui-react","by":"demo-agent"}'
$BIN backlog upsert-component --input '{"project":"sox-ecosystem","name":"sox-memory-core","by":"demo-agent"}'

# Issues
$BIN backlog create --input '{"title":"nx build fails after fastify bump","body":"Build breaks in packages/workspace after the fastify version bump.","project":"adhd","component":"backlog","kind":"bug","priority":"high","by":"demo-agent"}'
$BIN backlog create --input '{"title":"sign-in button unresponsive on rate-limit page","body":"The sign-in button stops responding once the rate-limit banner renders.","project":"adhd","component":"ui-react","kind":"bug","priority":"high","by":"demo-agent"}'
$BIN backlog create --input '{"title":"memory server crash on embed batch","body":"sox-memory-core crashes when a batch embed request exceeds the configured size.","project":"sox-ecosystem","component":"sox-memory-core","kind":"bug","priority":"medium","by":"demo-agent"}'
```

Each `create` call's real response carries the issue's `uid` (a generated identifier —
there is no human-readable ID in the shipped surface); use that returned `uid` for any
follow-on `get`/`update`/`transition`/`claim`/`relate` call, as shown in `../DEMO.md`.

## No-op repos (ambiguity fixture)

The following names deliberately have no seeded issues, to exercise `query`/`lookup`
returning an empty result rather than an error:

```bash
$BIN backlog upsert-project --input '{"name":"tools","by":"demo-agent"}'
```
