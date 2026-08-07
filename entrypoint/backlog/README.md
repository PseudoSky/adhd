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

## Running as a live server (no codegen)

```ts
import { startBacklogServer } from '@adhd/backlog';

const abort = new AbortController();
await startBacklogServer({ transport: 'both', port: 3400, signal: abort.signal });
```

- `POST /backlog/client-d/create-item`, `GET /backlog/client-d/get-item`, ... —
  every `client.ts` export, mounted live via `@adhd/apigen-plugin-api-fastify`.
  (The `client-d` route segment is not a typo — see `DESIGN.md` §7's CLI
  section / `SPEC.md` §7's transport table for why it's there.)
- Every export is also available as an MCP tool (e.g. `backlog_client_d_get_item`)
  via `@adhd/apigen-plugin-mcp` (stdio transport by default).

## CLI (`backlog`, live apigen mount — no codegen)

```bash
pnpm add -g @adhd/backlog   # installs the `backlog` bin
backlog --help              # live-derived command listing
backlog create-item --input '{"family":"BUG-EXAMPLE","title":"t","body":"b","repo":"org/repo"}'
backlog get-item --repo org/repo --human-id BUG-EXAMPLE-001
backlog list-items --filter '{"status":"OPEN"}'
```

- Same architecture as the HTTP/MCP transports above — `entrypoint/backlog/src/cli.ts`'s
  `runBacklogCli()` reuses `buildBacklogApigenPackage()` and hands it straight
  to `@adhd/apigen-plugin-cli-output`'s `run()`. No `apigen generate`, no
  bespoke argument parsing — routing, flag parsing, validation, dispatch, and
  exit codes all come from that plugin.
- **You type `backlog <command>`, never the internal `client-d` segment.**
  `runBacklogCli` derives the real command-table prefix from the live
  `operations` list at runtime (`resolveCommandPrefix`) and prepends it before
  dispatch — so `backlog get-item …` resolves even though the plugin's real
  command table is keyed `backlog client-d get-item` internally (same
  `client-d` artifact as the HTTP/MCP routes above; the CLI is the one
  transport that hides it from the caller).
- Flags are the schema's domain params, kebab-cased (`humanId` → `--human-id`);
  object/array-typed params take a JSON string (`--input '{...}'`,
  `--filter '{...}'`).
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
