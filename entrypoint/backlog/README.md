# @adhd/backlog

A structured, queryable, multi-agent-safe **graph store** for backlog items (bugs,
debt, features, investigations, plans) — a replacement for ad-hoc `BACKLOG.md`
editing that stays compatible with the existing markdown convention this repo
already uses.

Built on `@adhd/sox-graph-store` (bi-temporal nodes/edges over SQLite) and mounted
live via `@adhd/apigen-core-client` (no code generation — `extract()` →
`composeSchemas()` → `plugin.run()`).

See `SPEC.md` (functional spec: personas, data model, status vocabulary,
operation surface) and `DESIGN.md` (technical design: graph mapping, claim
protocol, env/apigen wiring) in this package for the full contract.

```bash
pnpm add @adhd/backlog
```

## Usage

```ts
import { createItem, listItems, claimItem, transitionStatus } from '@adhd/backlog';
import { buildBacklogEnv } from '@adhd/backlog';
import { openGraphBacklogStore } from '@adhd/backlog';

const env = buildBacklogEnv();
env.ensureDirs();
const store = openGraphBacklogStore(env.files.db);
const ctx = { store, env };

const { item } = await createItem(ctx, {
  family: 'BUG-EXAMPLE',
  title: 'Example bug',
  body: 'Something is broken.',
  repo: 'PseudoSky/adhd',
});

await claimItem(ctx, item.repo, item.humanId, 'implementer:abc123');
await transitionStatus(ctx, item.repo, item.humanId, 'FIXED', {
  by: 'implementer:abc123',
  citations: [{ file: 'entrypoint/backlog/src/client.ts' }],
});

const open = await listItems(ctx, { repo: item.repo, status: 'open' });
```

## Lifecycle hooks (FEAT-BACKLOG-001)

`registerBacklogHook(store, hook)` subscribes a fire-and-forget observer to
every real write on a `GraphBacklogStore` — never a no-op branch (a
dedupe-suppressed or id-collision `create`, a contended `held` claim, an
already-unclaimed `release`, a citation-gate-rejected `transitionStatus`):

```ts
import { registerBacklogHook } from '@adhd/backlog';

const unregister = registerBacklogHook(store, (event) => {
  switch (event.type) {
    case 'itemCreated':
      console.log('created', event.item.humanId);
      break;
    case 'itemTransitioned':
      console.log(`${event.item.humanId}: ${event.from} -> ${event.to}`);
      break;
  }
});
```

Event types: `itemCreated`, `itemUpdated`, `itemTransitioned`, `itemResolved`,
`itemClaimed`, `itemReleased`. A hook fires only after its triggering write
has genuinely committed; a hook that throws (sync or async) is isolated —
it never breaks the write it observed, and never blocks other registered
hooks on the same store.

## Citation blast-radius enrichment (FEAT-BACKLOG-006)

A citation naming a `symbol` (`{ file, lines?, context?, symbol? }`) gets
best-effort blast-radius data stamped onto it for free at write time: the
store shells out to `gitnexus impact <symbol> --repo <repo>` (bounded
~2.5s timeout, never blocks or fails the write) and, if gitnexus is
installed and the repo is indexed, adds `blastRadius: { risk, impactedCount,
direction }` to the citation. Absence of `blastRadius` means "not enriched"
(gitnexus unavailable, unindexed, timed out, or symbol not found) — never
"confirmed zero blast radius."

## Semantic search (optional, P4 RAG scaffolding)

An injectable `SemanticBackend` seam lets `query`'s `sort:"relevance"` do
real vector-similarity search instead of falling back to FTS/`textMatch`.
It is entirely opt-in: `@adhd/sox-vector-store` and
`@adhd/sox-embedding-provider` are `optionalDependencies`, loaded via a
non-literal dynamic `import()` so a consumer who never installs them pays
zero cost and gets a clean fallback rather than a resolution error.

## Store backup/restore (`admin` actions `backup`/`restore`)

Point-in-time backup via SQLite `VACUUM INTO`, with a sha256 + size manifest
sidecar for integrity verification:

```bash
adhd-backlog admin --input '{"action":"backup","params":{"destPath":"/path/to/backup.db"}}'
adhd-backlog admin --input '{"action":"restore","params":{"backupPath":"/path/to/backup.db","destDbPath":"/path/to/restore-target.db","confirm":true}}'
```

`restore` is dry-run by default (`confirm` defaults to `false`, and the
response carries a warning describing what *would* happen) and refuses to
restore onto the path of the caller's own live open store.

## Running as a live server (no codegen)

```ts
import { startBacklogServer } from '@adhd/backlog';

const abort = new AbortController();
await startBacklogServer({ transport: 'both', port: 3400, signal: abort.signal });
```

- `POST /backlog/create`, `GET /backlog/get`, ... — one route per verb of the
  six-verb INTERFACE_v2 surface (`get`/`query`/`create`/`update`/`relate`/`admin`),
  mounted live via `@adhd/apigen-plugin-api-fastify`. (`extractClientOperations()`
  passes `dropFileSegment: true` specifically so no `client-d` artifact segment
  leaks into the route — see `server.ts`'s `extractClientOperations`.)
- Every verb is also available as an MCP tool (`backlog_get`, `backlog_query`,
  `backlog_create`, `backlog_update`, `backlog_relate`, `backlog_admin`) via
  `@adhd/apigen-plugin-mcp` (stdio transport by default).

## CLI (`adhd-backlog`, live apigen mount — no codegen)

```bash
corepack enable
corepack prepare pnpm@8.15.9 --activate   # pin to the repo's packageManager, avoids ERR_PNPM_UNEXPECTED_STORE
pnpm add -g @adhd/backlog   # installs the `adhd-backlog` bin (renamed from the bare
                             # `backlog` bin, which collided with the unrelated public
                             # npm package `backlog@1.4.56`)
adhd-backlog --help         # live-derived command listing
adhd-backlog create --input '{"item":{"family":"BUG-EXAMPLE","title":"t","body":"b","repo":"org/repo"},"by":"me:1"}'
adhd-backlog get --input '{"humanId":"BUG-EXAMPLE-001","repo":"org/repo"}'
adhd-backlog query --input '{"filter":{"status":"OPEN"}}'
```

- Same architecture as the HTTP/MCP transports above — `entrypoint/backlog/src/cli.ts`'s
  `runBacklogCli()` reuses `buildBacklogApigenPackage()` and hands it straight
  to `@adhd/apigen-plugin-cli-output`'s `run()`. No `apigen generate`, no
  bespoke argument parsing — routing, flag parsing, validation, dispatch, and
  exit codes all come from that plugin.
- **INTERFACE_v2 collapsed the CLI to six verbs, one calling convention.**
  Every verb takes a single `--input '<json>'` flag carrying one JSON object —
  there are no per-field flags any more (the old `--repo`/`--human-id`/`--filter`
  style is retired; a v1 command name like `create-item`/`get-item`/`list-items`
  now exits `4`, unknown command). See `skill/SKILL.md` §2 for the full input
  shape of each verb.
- Exit codes follow `@adhd/apigen-base-errors`'s `CLI_EXIT_CODE` table: `0`
  success, `2` invalid argument (bad/unknown flag, failed validation), `4`
  unknown command, etc. Result is printed as JSON to stdout; errors as JSON to
  stderr.
- Honors the same `ADHD_BACKLOG_SCOPE`/`ADHD_ENV_SCOPE` scope env vars as the
  library API (see Scope below) — there is no separate CLI-only config.
- `runBacklogCli(argv?, opts?)` is also exported for in-process programmatic
  use (e.g. a test harness), symmetric with `startBacklogServer`.

## Scope

Resolved via `@adhd/environment` (see `env.ts`): `global` (default —
`~/.adhd/backlog/<namespace>/data/backlog.db`, spans every repo on the
machine), `project` (`<projectRoot>/.adhd/backlog/<namespace>/data/backlog.db`,
one repo), or `system`. See `SPEC.md` §3 for the full resolution order.
