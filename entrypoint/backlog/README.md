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

- `POST /backlog/createItem`, `GET /backlog/getItem`, ... — every `client.ts`
  export, mounted live via `@adhd/apigen-plugin-api-fastify`.
- Every export is also available as an MCP tool via `@adhd/apigen-plugin-mcp`
  (stdio transport by default).

## Scope

Resolved via `@adhd/environment` (see `env.ts`): `global` (default —
`~/.adhd/backlog/<namespace>/data/backlog.db`, spans every repo on the
machine), `project` (`<projectRoot>/.adhd/backlog/<namespace>/data/backlog.db`,
one repo), or `system`. See `SPEC.md` §3 for the full resolution order.
