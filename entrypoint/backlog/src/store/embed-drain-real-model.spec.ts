/**
 * guards: the real-model suite cannot silently drift from its paired e2e file, and its wiring is reachable without a model    tier: S    cites: 4256bc8b AC1, 4256bc8b AC2, 4256bc8b AC3, 4256bc8b (item 4256bc8b-3162-4bab-85de-8fe454724b2c)
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
 * Negative control (AC2): add a throwaway `it('x', ...)` to the e2e file and confirm the
 * AC2 test fails; revert before committing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBacklogEnv } from '../env.js';
import { bootstrapSemanticStoreMembers } from '../write/bootstrap.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
} from '../test/helpers/open-test-issue-store.js';
import {
  createFakeEmbeddingModule,
  FAKE_EMBEDDING_DIMENSIONS,
} from '../test/helpers/fake-embedding-provider.js';

vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());

const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED';
const E2E_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'embed-drain-real-model.e2e.ts'
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

/** Extracts the title of every `it(` call in the e2e source. */
function e2eItTitles(src: string): string[] {
  const titles: string[] = [];
  const re = /\bit\(\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) titles.push(m[1]!);
  return titles;
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
    } finally {
      await handle.close();
      removeTestIssueStoreDir(dir);
    }
  });
});
