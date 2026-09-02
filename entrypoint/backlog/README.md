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

- `POST /backlog/create`, `GET /backlog/get`, ... — one route per verb of the
  six-verb INTERFACE_v2 surface (`get`/`query`/`create`/`update`/`relate`/`admin`),
  mounted live via `@adhd/apigen-plugin-api-fastify`. (`extractClientOperations()`
  passes `dropFileSegment: true` specifically so no `client-d` artifact segment
  leaks into the route — see `server.ts`'s `extractClientOperations`.)
- Every verb is also available as an MCP tool (`backlog_get`, `backlog_query`,
  `backlog_create`, `backlog_update`, `backlog_relate`, `backlog_admin`) via
  `@adhd/apigen-plugin-mcp` (stdio transport by default).

## Web UI prototype (`nx serve backlog`)

A zero-build browser UI over the REST API, wired as the backlog project's
`serve` Nx target:

```bash
nx serve backlog            # then open http://127.0.0.1:4173/
nx serve backlog -- --sandbox   # isolated throwaway store (never the real graph)
```

`nx serve backlog` runs `tools/run-web-ui.mjs`, which spawns the REAL built CLI
(`serve --transport http`, the same binary a consumer installs from npm) plus a
static + same-origin proxy web server (`tools/web-ui-server.mjs`). The browser
talks to one origin (`/backlog/*`, `/_batch/*`, `/_meta/*` are proxied to the
API) — the fastify mount registers no CORS, so the proxy is what makes the page
work from a browser at all.

The UI (`tools/web-ui/index.html`, single file, no build step) browses items
(query list with repo/status/family/text filters + sort), opens a deep detail
panel (every `BacklogItem` field, with dedicated containers for citations,
notes, audit trail, related, rollup and blockers) and creates items with every
`CreateItemInput` field exposed as a dropdown or input. Two third-party
libraries load from the jsDelivr CDN at runtime — **marked@12** for markdown
rendering (bodies/notes) and **DOMPurify@3.1.5** to sanitize marked's HTML
output — so the page needs network access to the CDN (no vendored copies; no
build). The status filter follows the API's "one closedness knob" model: the
list defaults to `open` (non-terminal) — the API has no all-statuses list
mode — and `closed` (terminal) is one click away; exact-status options are
grouped separately. The repo filter is a dropdown populated from distinct
repos in the store (default: all repos); text and family search auto-apply
with a 300ms debounce.

The list supports **multi-select** (⌘/Ctrl-click a card, per-card checkboxes,
select-all) and a **batch bar** at the bottom of the side panel that appears
only when ≥2 items are selected, fanning out through the real `_batch/action`
mount: **set status** (adds an inline `backlog-web-ui` citation so terminal
transitions satisfy the no-citation-no-claim rule) and **delete** (soft-delete
tombstone, confirm-gated). **Move** is intentionally disabled — per-item repo
moves do not exist in the API (only whole-repo `reconcile_repo`); filed as
FEAT-008. List and detail scroll independently.

Filters (status/family/repo) are **multi-select** checkboxes on separate rows
(label left, control right). The API's filter keys are single-valued, so
multi-select fan-out runs one query per selected combination (capped at 32)
and merges + re-sorts client-side. Status offers the lifecycle knob (`open` /
`closed`) plus every exact status. Cards are three lines: id + status +
priority chips, a one-line truncated title, and repo chip + right-aligned
relative age.

The detail panel has an **edit** button that opens the create tab in **save
mode**: every editable field pre-filled, title/body/tags/projectPath saved via
`patch`, status/priority transitions with inline citations, **citations as a
multi-input** (add/remove rows; attached via `addCitation` when status is
unchanged). Identity fields (family/repo/id) and non-editable ones (plan,
author, reporter, importedFrom, force) are locked or hidden in edit mode;
required fields (title, family, by) are validated.

A **stats tab** (rendered with ECharts from the jsDelivr CDN) provides
Overview (KPI row, family composition, priority × lifecycle matrix, status
distribution, repo breakdown, aging histogram), Timelines (daily transitions
from the backend summary + client-side created/week), a client-side **slice
& dice pivot** (any dimension × dimension with a measure), Analytics cards
(critical-aging, rot, quality gates, drain forecast), and a **citation
heatmap** (family × lifecycle coverage, from per-item batched `get`s). Every
stat carries a **backend-support badge**: numbers the API doesn't expose
(historical closed-per-week, state-at-date, citation aggregates, scope-scoped
quality gates) are flagged in the UI with the reason instead of being faked.
Clicking a cell/bar drills into the search view with the filters applied.

Coverage: `src/web-ui.spec.ts` drives the full seam end-to-end (spawns the
orchestrator → real dist CLI → real HTTP → isolated store, asserts create →
query → get round-trip, error passthrough, and clean SIGTERM shutdown). Batch
shapes are verified live against the sandboxed API (`_batch/action` takes the
raw mount body — no `{data:{…}}` envelope — with items wrapped as
`{input: <op payload>}`).

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

## Semantic search (RAG) — opt-in

Backlog can find items by **meaning** rather than keywords: a paraphrased
duplicate that shares no words with the original still matches. This is
**off by default** and has no hard dependency — with it disabled, backlog
behaves exactly as it always has.

### Enabling it

Install the two optional peers, then turn it on **in the `@adhd/environment`
config file** — not with an environment variable. Backlog resolves to `global`
scope by default (`SPEC.md` §3), so the one file below switches semantic search
on for every backlog process on the machine: every CLI invocation, every MCP
server registration, and every agent session, with nothing to remember to
export and nothing to add to a `.mcp.json` `env` block.

```bash
pnpm add @adhd/sox-embedding-provider @adhd/sox-vector-store
```

`~/.adhd/backlog/production/config.yaml`:

```yaml
embedding:
  enabled: true
```

Then populate the vector space once — until you do, semantic reads answer
`rag_not_configured` rather than ranking against an empty index:

```bash
# count first — a dry run never calls the model
adhd-backlog admin --input '{"action":"embedding_backfill","params":{"dryRun":true}}'
# then embed (`by` is required as soon as the sweep actually writes)
adhd-backlog admin --input '{"action":"embedding_backfill","params":{"dryRun":false},"by":"you"}'
# expect ok:true
adhd-backlog admin --input '{"action":"embedding_health"}'
```

The backfill embeds **non-terminal items only** and reports what it left out as
`skippedTerminal`. That is deliberate: `run_dedup_sweep` iterates every vector
with no status predicate of its own, so embedded closed items would pull live
items into advisory `SAME_AS` edges with already-finished work. Pass
`"includeTerminal": true` when you specifically want to search closed history
("has this been fixed before?").

| Setting | Config key | Env override | Default |
|---|---|---|---|
| Enable RAG | `embedding.enabled` | `ADHD_BACKLOG_EMBEDDING_ENABLED` | `false` |
| Provider | `embedding.provider` | `ADHD_BACKLOG_EMBEDDING_PROVIDER` | `fastembed` |
| Model | `embedding.model` | `ADHD_BACKLOG_EMBEDDING_MODEL` | `bge-base-en-v1.5` (768-dim) |

The env vars still work and still win — they are the highest-precedence layer
of the cascade (code default → system → **global** → project → local → env
var), which makes them right for a one-off override in a single shell:

```bash
ADHD_BACKLOG_EMBEDDING_ENABLED=false adhd-backlog query --input '{"filter":{"grep":"leak"}}'
```

They are the wrong place for the standing setting, because an exported variable
only reaches the processes that inherit it — a `.mcp.json`-launched server, a
cron job, or another agent's shell would each silently fall back to `false`, and
you would get `rag_not_configured` from one caller and results from another
against the same store. Scope it narrower by writing the same two lines to
`<repo>/.adhd/backlog/production/config.yaml` and running with
`ADHD_BACKLOG_SCOPE=project`.

Embedding runs **locally** (ONNX via fastembed) — no API key, no network
after the model is cached, no per-query cost.

**Requirements.** The store must be on a substrate with native vectors
(the default turso adapter). Enabling it without the optional packages, on a
non-vector adapter, or with a provider that fails to construct logs a typed
reason and leaves semantic search off — it never crashes startup, and never
silently pretends to work.

### What it gives you

```bash
# find by meaning, not keywords
adhd-backlog query --input '{"filter":{"semantic":"connections leak under load"}}'

# items similar to a known one
adhd-backlog query --input '{"view":"similar","filter":{"anchor":"BUG-BACKLOG-001"}}'
```

- `filter.semantic` — free-text meaning search
- `view:"similar"` + `filter.anchor` — neighbours of a given item, plus
  `suggestedRelated` / `suggestedDependencies`
- `sort:"relevance"` — rank by similarity
- `fields:["_vector"]` — the raw embedding
- **Semantic dedupe on create** — filing an item that restates an existing
  one is caught even when the wording is entirely different

> **This one changes existing behaviour, so know it before you enable
> globally.** Once the vector space is populated, a `create` that previously
> succeeded can come back as the `duplicate_candidate` error arm, because the
> filing gate now compares *meaning* and not just keywords. That is the
> feature working — but it means scripts, fixtures, and agents that mint
> similarly-worded items need to say so explicitly:
>
> ```json
> {"item": {...}, "by": "you", "duplicateAction": "file"}
> ```
>
> `duplicateAction` defaults to `"abort"` (refuse and return the candidates);
> `"file"` is the confirmed re-file that mints anyway.
- `admin` actions: `embedding_health`, `embedding_backfill`,
  `list_near_duplicates`, `run_dedup_sweep`, `cluster_into_plans`,
  `promote_cluster_to_plan`

### With it disabled

Every semantic input fails **loudly** with `rag_not_configured` rather than
quietly falling back to a keyword search that would return plausible-looking
but wrong results. `filter.grep` is always pure full-text search and is
never affected by this setting either way.

### Notes

- Embedding happens **after** the write commits, so creates never block on
  the model and an embedding failure can never fail a write — the item stays
  fully readable and full-text searchable, and `admin(embedding_backfill)`
  repairs it. Pass `awaitEmbed: true` when you need the vector durable before
  you return (tests, scripts).
- The model id is recorded per item from the provider's **resolved** model,
  so you can always tell what actually embedded a given row.
- Changing `embedding.model` does not silently reinterpret existing vectors:
  dimensions are a structural contract. Re-embed with
  `admin(embedding_backfill)`.
