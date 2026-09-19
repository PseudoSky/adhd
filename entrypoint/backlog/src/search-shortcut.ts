/**
 * search-shortcut.ts — `backlog search "<text>" [flags]`, a pure ARGV
 * TRANSLATION onto the mounted `query` operation.
 *
 * ## Why a translation and not a seventh operation
 *
 * INTERFACE_v2 §3 fixes the apigen mount surface at exactly six verbs
 * (`get, query, create, update, relate, admin`) — `index.ts`'s own comment
 * above those exports says "these, and only these". Adding a `search` export
 * to `client.ts` would widen that surface for every transport (CLI, HTTP,
 * MCP) to buy CLI ergonomics, which is the wrong trade. So `search` never
 * becomes an operation: `runBacklogCli` rewrites its argv into
 * `['query', '--input', '<json>']` and hands it to the SAME
 * `@adhd/apigen-plugin-cli-output` dispatch every other command goes
 * through. Store lifecycle, signal cleanup, `exitCodeForEnvelope` mapping and
 * output shape are therefore reused unchanged rather than reimplemented —
 * this module is a pure function over `string[]` and opens nothing.
 *
 * ## Why the positional compiles to `text`, not `filter.semantic`
 *
 * `IBacklogQueryInput.text` is already specified as "the natural-language
 * query; also the CLI positional form" (§2.1b) — this shortcut is the CLI
 * form that field was written for. `compileTextQuery` (v2/query.ts) routes
 * the whole string into `filter.semantic` when the vector space is readable
 * and into `filter.grep` when it is NOT (RAG-SPEC §3.1 / BUG-045), and picks
 * `sort: "relevance"` or `"textMatch"` to match. Compiling the positional
 * straight to `filter.semantic` instead would hard-fail with
 * `rag_not_configured` on an unconfigured or unbackfilled store, throwing
 * away a working keyword answer — and would ALSO need this module to
 * hardcode a `sort` default that `compileTextQuery` already derives
 * correctly. Neither divergence is worth owning here.
 *
 * For the same reason there is no `fields` default: the `text` path's own
 * projection is already the compact `humanId/kind/title/status/priority`
 * list, so a default invented here could only make it worse. `--fields`
 * overrides it (add `_score` to see the ranking scores).
 *
 * ## Error parity
 *
 * The flags below are hand-parsed, not schema-derived, so every rejection
 * mirrors `@adhd/apigen-plugin-cli-output`'s `parseArgs`/validate-Layer
 * wording byte-for-byte, exactly as `runMigrationPhaseCommand` (cli.ts)
 * does: `Unknown option: --X. Available: …` (a REAL list, never a placebo),
 * `Missing value for --X`, `Unexpected positional argument: "X"`. The caller
 * prints them as `{"code":"invalid_argument","message":…}` on stderr with
 * `process.exitCode = 2` (`CLI_EXIT_CODE['invalid_argument']`).
 *
 * DEBT-BACKLOG-001 (the backlog CLI's bespoke argv parsing diverging from the
 * apigen-mounted surface) is enlarged by this file, deliberately and with the
 * parity discipline above; see that item.
 */

/** Top-level `IBacklogQueryInput` keys this shortcut exposes as flags. */
const SCALAR_TOP_LEVEL_FLAGS = ['limit', 'offset', 'sort', 'direction'] as const;

/** `IBacklogFilter` keys exposed as single-valued flags. */
const SCALAR_FILTER_FLAGS = [
  'repo',
  'kind',
  'family',
  'plan',
  'assignee',
  'claimed-by',
  'project-path',
  'grep',
  'anchor',
] as const;

/**
 * `IBacklogFilter` keys that accept a LIST. Each is comma-splittable in one
 * token AND repeatable across tokens (`--tag a --tag b` ≡ `--tag a,b`), which
 * is the union of the two conventions a caller might reach for.
 *
 * `status` and `priority` collapse to a bare string when exactly one value is
 * given: `IStatusSelector` is `IStatusClosedness | BacklogStatus |
 * BacklogStatus[]`, so `--status open` must stay the scalar closedness word
 * `"open"` rather than becoming `["open"]` (which is not a `BacklogStatus`).
 */
const LIST_FILTER_FLAGS = ['status', 'priority', 'tag'] as const;

/** Flags whose single value is a comma-separated projection list (`IProjection.fields`). */
const LIST_TOP_LEVEL_FLAGS = ['fields'] as const;

/** Flag name → the `IBacklogFilter` key it writes, where the kebab flag differs from the camel key. */
const FILTER_KEY_ALIASES: Readonly<Record<string, string>> = {
  'claimed-by': 'claimedBy',
  'project-path': 'projectPath',
  tag: 'tags',
};

/**
 * The complete, REAL flag vocabulary — the `Available:` list an unknown-option
 * rejection prints. Derived from the four arrays above rather than
 * hand-maintained, so a flag can never be accepted but unlisted (or listed
 * but unaccepted).
 */
export const SEARCH_FLAGS: readonly string[] = [
  ...SCALAR_TOP_LEVEL_FLAGS,
  ...LIST_TOP_LEVEL_FLAGS,
  ...SCALAR_FILTER_FLAGS,
  ...LIST_FILTER_FLAGS,
]
  .map((f) => `--${f}`)
  .sort();

const TOP_LEVEL_FLAGS = new Set<string>([...SCALAR_TOP_LEVEL_FLAGS, ...LIST_TOP_LEVEL_FLAGS]);
const LIST_FLAGS = new Set<string>([...LIST_FILTER_FLAGS, ...LIST_TOP_LEVEL_FLAGS]);
const KNOWN_FLAGS = new Set<string>([
  ...SCALAR_TOP_LEVEL_FLAGS,
  ...LIST_TOP_LEVEL_FLAGS,
  ...SCALAR_FILTER_FLAGS,
  ...LIST_FILTER_FLAGS,
]);

/** `--limit`/`--offset` are numbers in the schema; every other flag is a string. */
const NUMERIC_FLAGS = new Set<string>(['limit', 'offset']);

export const SEARCH_HELP = [
  'backlog search "<natural-language query>" [flags]',
  '',
  'Shorthand for `backlog query --input \'{"text": "<query>", ...}\'` — the same',
  'command, the same JSON envelope, the same exit codes. The query text is',
  'matched semantically when the embedding space is populated, and by keyword',
  '(FTS) when it is not.',
  '',
  'Paging / ranking:',
  '  --limit <n>        max items to return',
  '  --offset <n>       skip the first n',
  '  --sort <s>         override the derived default (relevance / textMatch)',
  '  --direction <d>    asc | desc',
  '  --fields <a,b,c>   projection; add _score to see ranking scores',
  '',
  'Filters (all compose with the query text):',
  '  --status <s>       open | closed | OPEN,IN_PROGRESS | …',
  '  --priority <p>     CRITICAL | HIGH | MEDIUM | LOW (comma-separated for several)',
  '  --kind <k>         BUG | DEBT | FEAT | …',
  '  --family <f>       humanId minus the trailing -NNN, e.g. BUG-APIGEN',
  '  --repo <r>         repo key',
  '  --project-path <p> package-relative path within the repo',
  '  --plan <slug>      plan slug',
  '  --assignee <a>     durable owner',
  '  --claimed-by <c>   ephemeral claim holder',
  '  --tag <t>          repeatable, or comma-separated',
  '  --grep <q>         extra keyword predicate. Composes with the query text ONLY',
  '                     once the embedding space is populated — without it the query',
  '                     text IS the keyword query and the two collide (§2.1b step 1).',
  '',
  'More-like-this:',
  '  --anchor <ID>      nearest neighbours of an EXISTING item (view:"similar").',
  '                     Replaces the positional query rather than refining it.',
].join('\n');

/** A rendered `--help`, a rejection, or the rewritten argv to dispatch. */
export type SearchShortcutOutcome =
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'argv'; argv: string[] };

function pushValue(bag: Record<string, unknown>, key: string, raw: string, isList: boolean): void {
  if (!isList) {
    bag[key] = raw;
    return;
  }
  const previous = (bag[key] as string[] | undefined) ?? [];
  bag[key] = [...previous, ...raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)];
}

/**
 * Translates `search`'s tokens (everything AFTER the `search` word) into the
 * `['query', '--input', '<json>']` argv the apigen command table dispatches.
 *
 * Pure: reads no config, opens no store, touches no globals — so the caller
 * can reject a bad invocation before any of `runBacklogCli`'s store lifecycle
 * has started, and so every branch here is unit-testable on its own.
 */
export function buildSearchArgv(rest: readonly string[]): SearchShortcutOutcome {
  // Mirrors cli-output's own pre-dispatch check (and `runMigrationPhaseCommand`'s):
  // `--help` ANYWHERE after the command shows usage, never an error.
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help', text: SEARCH_HELP };

  const topLevel: Record<string, unknown> = {};
  const filter: Record<string, unknown> = {};
  let text: string | undefined;

  let i = 0;
  while (i < rest.length) {
    const token = rest[i] as string;

    if (!token.startsWith('--')) {
      if (text !== undefined) return { kind: 'error', message: `Unexpected positional argument: "${token}"` };
      text = token;
      i += 1;
      continue;
    }

    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    // `--input` is the raw form this shortcut exists to avoid typing. A caller
    // who wants it is on the right tool but the wrong command, so say which
    // one rather than burying it in the generic unknown-option list.
    if (name === 'input') {
      return {
        kind: 'error',
        message: 'Unknown option: --input. `search` takes the query as a positional argument; for the raw JSON form use `backlog query --input \'{...}\'`',
      };
    }
    if (!KNOWN_FLAGS.has(name)) {
      return { kind: 'error', message: `Unknown option: --${name}. Available: ${SEARCH_FLAGS.join(', ')}` };
    }

    i += 1;
    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      if (i >= rest.length) return { kind: 'error', message: `Missing value for --${name}` };
      value = rest[i] as string;
      i += 1;
    }

    const isList = LIST_FLAGS.has(name);
    if (TOP_LEVEL_FLAGS.has(name)) {
      pushValue(topLevel, name, value, isList);
    } else {
      pushValue(filter, FILTER_KEY_ALIASES[name] ?? name, value, isList);
    }
  }

  // `--status open` must stay the scalar closedness word, not `["open"]`;
  // same for a lone `--priority HIGH` (`Priority | readonly Priority[]`).
  for (const key of ['status', 'priority'] as const) {
    const values = filter[key] as string[] | undefined;
    if (values?.length === 1) filter[key] = values[0];
  }

  // Coerce ONLY where the schema says number, and only when the token really
  // is one: a non-numeric `--limit foo` is passed through as the string it
  // is, so validate-Layer emits its own authentic type error rather than this
  // module inventing a second, differently-worded one.
  for (const key of NUMERIC_FLAGS) {
    const value = topLevel[key];
    if (typeof value === 'string' && /^-?\d+$/.test(value)) topLevel[key] = Number(value);
  }

  const anchor = filter['anchor'] as string | undefined;
  if (anchor !== undefined && text !== undefined) {
    return {
      kind: 'error',
      message: 'Validation failed: --anchor and a positional query are mutually exclusive — --anchor ranks by an EXISTING item\'s vector (view:"similar"), so there is no query text to also match (INTERFACE_v2 §2.1)',
    };
  }
  if (anchor === undefined && text === undefined) {
    return {
      kind: 'error',
      message: 'Validation failed: /data must have required property \'text\' — Example: {"data":{"text":"flaky publish gate"}}',
    };
  }

  const input: Record<string, unknown> = { ...topLevel };
  // §2.1 — `filter.anchor` is `view:"similar"`'s seed, and that view rejects
  // `text`; the positional form is `view:"list"`'s (§2.1b), which is the
  // default and so is left unstated.
  if (anchor !== undefined) input['view'] = 'similar';
  else input['text'] = text;
  if (Object.keys(filter).length > 0) input['filter'] = filter;

  return { kind: 'argv', argv: ['query', '--input', JSON.stringify(input)] };
}
