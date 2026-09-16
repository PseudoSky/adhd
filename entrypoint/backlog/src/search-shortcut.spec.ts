/**
 * search-shortcut.spec.ts — unit coverage for `buildSearchArgv`, the pure
 * argv translation behind `backlog search`.
 *
 * These are unit tests ON PURPOSE and it is not a bypass of AGENTS.md §7's
 * "drive the real consumer path": `buildSearchArgv` IS a pure function over
 * `string[]` with no store, config or process state, and `cli.spec.ts` drives
 * the same feature end-to-end through the REAL spawned `dist/index.js` bin
 * (including a byte-for-byte parity assertion against the equivalent
 * `query --input` invocation, which is the actual behavioural contract).
 * What these add on top is exhaustive coverage of the rejection grammar,
 * where spawning ~20 subprocesses would buy nothing but wall-clock.
 */
import { describe, expect, it } from 'vitest';
import { buildSearchArgv, SEARCH_FLAGS, type SearchShortcutOutcome } from './search-shortcut.js';

/** The parsed `--input` JSON of a successful translation. Fails loudly on any other outcome. */
function inputOf(outcome: SearchShortcutOutcome): Record<string, unknown> {
  if (outcome.kind !== 'argv') throw new Error(`expected an argv outcome, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  expect(outcome.argv[0]).toBe('query');
  expect(outcome.argv[1]).toBe('--input');
  return JSON.parse(outcome.argv[2] as string) as Record<string, unknown>;
}

function messageOf(outcome: SearchShortcutOutcome): string {
  if (outcome.kind !== 'error') throw new Error(`expected an error outcome, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  return outcome.message;
}

describe('buildSearchArgv — translation onto the mounted `query` verb', () => {
  it('compiles the positional to `text`, NOT `filter.semantic`', () => {
    // The whole point of §2.1b: `text` degrades to FTS on an unconfigured or
    // unbackfilled store, where `filter.semantic` hard-fails
    // `rag_not_configured`. If this ever flips to `filter.semantic`, `search`
    // stops working on every default build.
    const input = inputOf(buildSearchArgv(['flaky publish gate']));
    expect(input['text']).toBe('flaky publish gate');
    expect(input['filter']).toBeUndefined();
  });

  it('emits NO `sort` and NO `fields` of its own', () => {
    // `resolveTextInput` derives `relevance` (configured) / `textMatch`
    // (fallback) itself, and the `text` path already projects the compact
    // uid/kind/title/status/priority list. A default invented here would
    // override a correct one — and a hardcoded `sort: "relevance"` would
    // trip AC-12 on an unconfigured store.
    const input = inputOf(buildSearchArgv(['anything']));
    expect(input).not.toHaveProperty('sort');
    expect(input).not.toHaveProperty('fields');
    expect(Object.keys(input)).toEqual(['text']);
  });

  it('routes top-level flags to the top level and filter flags into `filter`', () => {
    const input = inputOf(
      buildSearchArgv(['stale claims', '--limit', '5', '--offset', '10', '--sort', 'priority', '--direction', 'asc', '--repo', 'PseudoSky/adhd', '--kind', 'BUG'])
    );
    expect(input).toEqual({
      limit: 5,
      offset: 10,
      sort: 'priority',
      direction: 'asc',
      text: 'stale claims',
      filter: { repo: 'PseudoSky/adhd', kind: 'BUG' },
    });
  });

  it('coerces --limit/--offset to numbers, and ONLY those two', () => {
    const input = inputOf(buildSearchArgv(['x', '--limit', '3', '--offset', '0', '--kind', '42']));
    expect(input['limit']).toBe(3);
    expect(input['offset']).toBe(0);
    // A numeric-looking string on a string-typed flag stays a string.
    expect((input['filter'] as Record<string, unknown>)['kind']).toBe('42');
  });

  it('passes a non-numeric --limit through UNCOERCED so validate-Layer owns the type error', () => {
    // Inventing a second, differently-worded numeric error here would diverge
    // from the message every other command emits for the same mistake.
    const input = inputOf(buildSearchArgv(['x', '--limit', 'lots']));
    expect(input['limit']).toBe('lots');
  });

  it('accepts the inline --flag=value form', () => {
    const input = inputOf(buildSearchArgv(['x', '--limit=2', '--status=open']));
    expect(input['limit']).toBe(2);
    expect(input['filter']).toEqual({ status: 'open' });
  });

  it('--fields is a comma-separated projection list', () => {
    const input = inputOf(buildSearchArgv(['x', '--fields', 'uid,title,_score']));
    expect(input['fields']).toEqual(['uid', 'title', '_score']);
  });

  it('--tag is repeatable AND comma-splittable, and the two forms agree', () => {
    const repeated = inputOf(buildSearchArgv(['x', '--tag', 'a', '--tag', 'b']));
    const commaJoined = inputOf(buildSearchArgv(['x', '--tag', 'a,b']));
    expect((repeated['filter'] as Record<string, unknown>)['tags']).toEqual(['a', 'b']);
    expect(commaJoined).toEqual(repeated);
  });

  it('a LONE --status stays a scalar (IStatusSelector closedness), several become an array', () => {
    // `--status open` must NOT become `["open"]`: `open` is an
    // `IStatusClosedness` word, and `["open"]` is not a `BacklogStatus[]`.
    expect(inputOf(buildSearchArgv(['x', '--status', 'open']))['filter']).toEqual({ status: 'open' });
    expect(inputOf(buildSearchArgv(['x', '--status', 'OPEN,IN_PROGRESS']))['filter']).toEqual({ status: ['OPEN', 'IN_PROGRESS'] });
  });

  it('a LONE --priority stays a scalar, several become an array (Priority | readonly Priority[])', () => {
    expect(inputOf(buildSearchArgv(['x', '--priority', 'HIGH']))['filter']).toEqual({ priority: 'HIGH' });
    expect(inputOf(buildSearchArgv(['x', '--priority', 'HIGH,CRITICAL']))['filter']).toEqual({ priority: ['HIGH', 'CRITICAL'] });
  });

  it('kebab flags map onto their camelCase IBacklogFilter keys', () => {
    const input = inputOf(buildSearchArgv(['x', '--claimed-by', 'agent-7', '--project-path', 'packages/apigen/apigen-core-client']));
    expect(input['filter']).toEqual({ claimedBy: 'agent-7', projectPath: 'packages/apigen/apigen-core-client' });
  });

  it('--anchor switches to view:"similar" and carries the seed in filter.anchor', () => {
    const input = inputOf(buildSearchArgv(['--anchor', 'DEBT-015', '--limit', '3']));
    expect(input).toEqual({ limit: 3, view: 'similar', filter: { anchor: 'DEBT-015' } });
    expect(input).not.toHaveProperty('text');
  });
});

describe('buildSearchArgv — rejection grammar (apigen parseArgs parity)', () => {
  it('--help renders usage rather than an error, from ANY position', () => {
    for (const argv of [['--help'], ['x', '--help'], ['-h'], ['x', '--limit', '2', '-h']]) {
      const outcome = buildSearchArgv(argv);
      expect(outcome.kind, `for argv ${JSON.stringify(argv)}`).toBe('help');
    }
  });

  it('an unknown option prints the REAL available list, never a placebo', () => {
    const message = messageOf(buildSearchArgv(['x', '--limitt', '5']));
    expect(message).toBe(`Unknown option: --limitt. Available: ${SEARCH_FLAGS.join(', ')}`);
    // "Real" means every listed flag is genuinely accepted — the list is
    // derived from the same arrays the parser consults, and this proves it.
    for (const flag of SEARCH_FLAGS) {
      // `--anchor` REPLACES the positional rather than refining it, so it is
      // probed in its own legal shape — not as an exception to the rule.
      const probe = buildSearchArgv(flag === '--anchor' ? [flag, 'BUG-1'] : ['x', flag, 'value']);
      expect(probe.kind, `${flag} is advertised as available but was rejected`).not.toBe('error');
    }
  });

  it('a flag with no value is "Missing value for --X"', () => {
    expect(messageOf(buildSearchArgv(['x', '--limit']))).toBe('Missing value for --limit');
  });

  it('a SECOND positional is "Unexpected positional argument"', () => {
    expect(messageOf(buildSearchArgv(['first', 'second']))).toBe('Unexpected positional argument: "second"');
  });

  it('no query at all reports the missing-required-property shape validate-Layer would', () => {
    expect(messageOf(buildSearchArgv([]))).toContain("must have required property 'text'");
  });

  it('--input is rejected by NAME, pointing at `query --input`', () => {
    // A caller reaching for the raw form is on the right tool and the wrong
    // command; burying that in the generic unknown-option list would hide it.
    const message = messageOf(buildSearchArgv(['x', '--input', '{}']));
    expect(message).toContain('Unknown option: --input');
    expect(message).toContain('backlog query --input');
  });

  it('--anchor and a positional query are mutually exclusive, in EITHER order', () => {
    expect(messageOf(buildSearchArgv(['--anchor', 'BUG-1', 'some text']))).toContain('mutually exclusive');
    expect(messageOf(buildSearchArgv(['some text', '--anchor', 'BUG-1']))).toContain('mutually exclusive');
  });
});
