/**
 * guards: the real-model suite cannot silently drift from its paired e2e file, and its wiring is reachable without a model
 * tier: S
 * cites: 4256bc8b AC1, AC2, AC3 (item 4256bc8b-3162-4bab-85de-8fe454724b2c)
 * Embeddings mocked here: vi.mock('@adhd/sox-embedding-provider') below swaps in the deterministic fake.
 *
 * The paired stub for `embed-drain-real-model.e2e.ts`. The real-model cases run
 * in the `e2e` lane (CI-only). This file is the tier S lane's entry for that
 * suite: it holds no real model and spawns no process.
 *
 * - AC1: the e2e header names its lane and command and drops the false "by default" claim.
 * - AC2: every `it(` title in the e2e file is listed in `MIRRORED_E2E_TITLES`. Adding an
 *   e2e case without listing it here turns the AC2 test red.
 * - AC3: the wiring of `bootstrapSemanticStoreMembers` resolves its members through the
 *   deterministic fake embedding provider, with no model and no subprocess.
 *
 * red: pending (user hold) — no test has been run in this wave; no run is recorded here.
 *   - AC1 test: command `npx nx test backlog -- embed-drain-real-model.spec`, against a base
 *     whose e2e header still says "runs by DEFAULT" or omits `npx nx run backlog:e2e`; expected
 *     failing assertion: `expect(header).not.toMatch(/by DEFAULT/)` or `toContain('npx nx run backlog:e2e')`.
 *   - AC2 tests: same command, against an e2e file with one extra, renamed, skipped, `.only`,
 *     `.each`, `test(` or non-single-quoted case; expected failing assertion: the sorted-title
 *     `toEqual` in the AC2 test (unmirrored title listed in the diff). The extractor itself is
 *     exercised by the AC2 extractor test on synthetic sources, so no edit to the e2e file is
 *     needed to prove the check has teeth.
 *   - AC3 test: same command, against a `bootstrapSemanticStoreMembers` that resolves a member
 *     other than through the mocked provider; expected failing assertion: the vector `toEqual`
 *     `embedTextDeterministic('wiring probe')` (a real model's vector cannot equal it).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBacklogEnv } from '../../../src/env.js';
import { bootstrapSemanticStoreMembers } from '../../../src/write/bootstrap.js';
import { freshTmpDir } from '../../helpers/tmp-store.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
} from '../../helpers/open-test-issue-store.js';
import {
  createFakeEmbeddingModule,
  embedTextDeterministic,
  FAKE_EMBEDDING_DIMENSIONS,
} from '../../helpers/fake-embedding-provider.js';

vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
const E2E_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../e2e/store/embed-drain-real-model.e2e.ts'
);

/** Every `it(` title of `embed-drain-real-model.e2e.ts`, in source order. Keep in step with that file (AC2). */
const MIRRORED_E2E_TITLES = [
  'a fire-and-forget create() through the production seam lands its vector when the store is closed by the drain',
  'a spawned `create` (fire-and-forget) exits 0 with no "unrecorded" on stderr, and a fresh store finds the vector',
  'a query with no shared token finds the created item through the semantic route and not an item whose vector was never written',
];

function e2eSource(): string {
  return readFileSync(E2E_FILE, 'utf8');
}

/**
 * Extracts one entry per `it(` / `test(` call site in the e2e source, in every quote
 * style (single, double, template). A call with a modifier (`it.skip`, `it.only`,
 * `it.todo`, `it.each`, `it.concurrent`, ...) yields `[<modifier>] <title>`, and an
 * `.each` or otherwise unparsable title yields `[<modifier>] <unparsed>`, so none of
 * them can equal a plain mirrored title: adding one turns the AC2 check red.
 */
function e2eItTitles(rawSrc: string): string[] {
  // Header and inline prose may contain `test (` / `it (`; only code declares cases.
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
  const entries: string[] = [];
  const head = /\b(?:it|test)((?:\.[A-Za-z]+)*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(src)) !== null) {
    const modifier = m[1]!.slice(1);
    const prefix = modifier === '' ? '' : `[${modifier}] `;
    let i = head.lastIndex;
    while (/\s/.test(src[i] ?? '')) i++;
    const quote = src[i];
    if (modifier.includes('each') || (quote !== "'" && quote !== '"' && quote !== '`')) {
      entries.push(`${prefix}<unparsed>`);
      continue;
    }
    let j = i + 1;
    let title = '';
    while (j < src.length && src[j] !== quote) {
      if (src[j] === '\\') {
        title += src[j]! + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      title += src[j];
      j++;
    }
    entries.push(`${prefix}${title}`);
    head.lastIndex = j; // resume after the title so text inside it is never rescanned
  }
  return entries;
}

describe('embed-drain-real-model (tier S stub for the e2e lane)', () => {
  let prevEnvVar: string | undefined;

  beforeEach(() => {
    prevEnvVar = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (prevEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnvVar;
  });

  it('4256bc8b AC1: the e2e header names the e2e lane and its command, and drops the false "by default" claim', () => {
    const src = e2eSource();
    const header = src.slice(0, src.indexOf('import '));
    expect(header).not.toMatch(/runs by DEFAULT/);
    expect(header).not.toMatch(/by DEFAULT/);
    expect(header).toMatch(/e2e lane/);
    expect(header).toContain('npx nx run backlog:e2e');
  });

  it('4256bc8b AC2: every it( title in the e2e file is mirrored in MIRRORED_E2E_TITLES', () => {
    const actual = e2eItTitles(e2eSource());
    expect(actual.length).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...MIRRORED_E2E_TITLES].sort());
  });

  it('4256bc8b AC2: the title extractor sees double-quoted, template, test(, and skip/only/todo/each forms, each as an entry no mirrored title can equal', () => {
    const synthetic = [
      "it('plain single', () => {});",
      'it("plain double", () => {});',
      'it(`plain template`, () => {});',
      "it(\n  'multi-line',\n  async () => {}\n);",
      "test('uses test()', () => {});",
      "it.skip('skipped', () => {});",
      "it.only('only', () => {});",
      "it.todo('todo');",
      'it.each([1, 2])("each %s", () => {});',
    ].join('\n');
    expect(e2eItTitles(synthetic)).toEqual([
      'plain single',
      'plain double',
      'plain template',
      'multi-line',
      'uses test()',
      '[skip] skipped',
      '[only] only',
      '[todo] todo',
      '[each] <unparsed>',
    ]);
    // Prose in comments is not code: a `test (` in a block or line comment is never a case.
    expect(e2eItTitles('/* per test (budget) */\n// it (x)\nit(\'real\', () => {});')).toEqual(['real']);
    for (const entry of e2eItTitles(synthetic).filter((e) => e.startsWith('['))) {
      expect(MIRRORED_E2E_TITLES).not.toContain(entry);
    }
  });

  it('4256bc8b AC3: bootstrapSemanticStoreMembers resolves search and embedding members through the fake provider, with no model and no subprocess', async () => {
    process.env[ENV_VAR] = 'true';
    const dir = freshTmpDir('embed-drain-real-model-wiring');
    const handle = await openTestIssueStore(join(dir, 'backlog.db'));
    try {
      const env = buildBacklogEnv({ adhdRoot: dir });
      const members = await bootstrapSemanticStoreMembers(
        handle.adapter,
        handle.graph,
        env.config.embedding
      );
      expect(members.search, 'search member must be wired').toBeDefined();
      expect(members.embedding, 'embedding member must be wired').toBeDefined();
      const vector = await members.embedding!.embedDocument('wiring probe');
      expect(vector.length).toBe(FAKE_EMBEDDING_DIMENSIONS);
      // The fake's dimensions (768) equal the real bge-base model's, so a dimension
      // match cannot tell fake from real. Identity only the fake has: the vector is
      // byte-identical to the fake's documented deterministic output for this text
      // (a real ONNX model cannot reproduce it), and is stable across calls.
      const expected = embedTextDeterministic('wiring probe');
      expect(Array.from(vector)).toEqual(Array.from(expected));
      const again = await members.embedding!.embedDocument('wiring probe');
      expect(Array.from(again)).toEqual(Array.from(vector));
    } finally {
      await handle.close();
      removeTestIssueStoreDir(dir);
    }
  });
});
