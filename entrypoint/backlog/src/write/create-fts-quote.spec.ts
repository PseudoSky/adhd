/**
 * create-fts-quote.spec.ts — behavioral proof for cfa0ec44: `createIssue`'s
 * dedupe scan must never let user text malform the FTS MATCH expression.
 *
 * Root cause (confirmed red before the fix): `similarity-scan.ts` handed the raw
 * title+body to `StoreSearchBackend.search` as the `text` signal. The store
 * adapter's `normalizeFtsTokens` strips `"` but not `\`, and its
 * `buildMatchQuery` wraps every whitespace token as `"<token>"`. A token
 * ending in a backslash (a JSON-escaped quote, `\"` once the quote is
 * stripped) therefore yields `"tok\"` — the closing quote is escaped, the
 * expression is unterminated, and the Tantivy parser throws
 * `FTS parse error: Syntax Error`, aborting the create.
 *
 * Real components throughout (real graph store, real hybrid search backend,
 * real `createIssue`); only the embedding model is faked (see
 * `create-duplicate-gate.spec.ts` for the scoped authorization).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogConfig } from '../env.js';
import { bootstrapSemanticStoreMembers } from './bootstrap.js';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';

// Embeddings mocked here — explicit, scoped user authorization (see
// entrypoint/backlog/STATE.md), covers embedding cost only.
vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import {
  createIssue,
  type ICreateIssueResult,
  type IDuplicateScanHandle,
} from './create-issue.js';
import type { IWriteStoreHandle } from './tx.js';
import { toFtsSafeText } from './similarity-scan.js';

const TIMEOUT = 30_000;

const EMBEDDING_CFG: BacklogConfig['embedding'] = {
  enabled: true,
  provider: 'fastembed',
  model: 'bge-base-en-v1.5',
};

type Handle = TestIssueStore & IWriteStoreHandle & IDuplicateScanHandle;

let dir: string;
let store: TestIssueStore;
let handle: Handle;
let projectUid: string;

beforeEach(async () => {
  dir = freshTmpDir('create-fts-quote-spec');
  store = await openTestIssueStore(join(dir, 'backlog.db'));
  const members = await bootstrapSemanticStoreMembers(
    store.adapter,
    store.graph,
    EMBEDDING_CFG
  );
  if (!members.search || !members.embedding) {
    throw new Error(
      'create-fts-quote.spec: real embedding backend unavailable (no search/embedding members)'
    );
  }
  handle = {
    ...store,
    graph: store.graph,
    search: members.search,
    embedding: members.embedding,
  };
  projectUid = (await seedProject(store, 'fts-quote-spec-project')).projectUid;
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

function file(
  title: string,
  body: string,
  extra?: Partial<Parameters<typeof createIssue>[1]>
): Promise<ICreateIssueResult> {
  return createIssue(handle, {
    project: projectUid,
    title,
    body,
    by: 'filer',
    awaitEmbed: true,
    ...extra,
  });
}

/** Hostile payloads: every quote/operator/escape shape the ticket names. */
const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  [
    'backslash-escaped double quote',
    String.raw`the user said \"fix it\" and view:\'order\' broke`,
  ],
  ['plain double quotes', 'a "quoted phrase" and an "unterminated'],
  ['single quotes', `it's the user's 'quoted' text`],
  ['wildcards and colons', 'col:value prefix* -negated (grouped) text'],
  ['boolean operators', 'alpha AND beta OR gamma NOT delta NEAR epsilon'],
  [
    'trailing backslash token',
    String.raw`ends with a lone backslash \ and C:\dir\ here`,
  ],
  ['only punctuation', String.raw`\ " ' ( ) : * -`],
];

describe('cfa0ec44 — create dedupe FTS scan with hostile user text', () => {
  for (const [label, text] of HOSTILE) {
    it(
      `cfa0ec44 AC1 [${label}]: create succeeds (abort) and (force) without the dedupe scan throwing`,
      async () => {
        const first = await file(`title: ${text}`, `body ${text}`);
        expect(first.created).toBe(true);
        // A second create of the same text drives the scan against a non-empty
        // corpus (the first create's scan saw an empty one).
        const aborted = await file(`title: ${text}`, `body ${text}`);
        expect(['duplicate-suppressed', undefined]).toContain(aborted.reason);
        const forced = await file(`title: ${text}`, `body ${text}`, {
          duplicateAction: 'force',
        });
        expect(forced.created).toBe(true);
      },
      TIMEOUT
    );
  }

  it(
    'cfa0ec44 AC2: dedupe still finds the real duplicate when the text contains quotes and escapes',
    async () => {
      const title = String.raw`user said \"retry\" on view:\'order\' failure`;
      const body = String.raw`verbatim: \"it crashes\" (see: foo*) AND the quoted evidence stays long enough to match`;
      const first = await file(title, body);
      expect(first.created).toBe(true);
      const second = await file(title, body);
      expect(second.created).toBe(false);
      expect(second.reason).toBe('duplicate-suppressed');
      expect(second.duplicateCandidates?.[0]?.uid).toBe(first.uid);
    },
    TIMEOUT
  );

  it('cfa0ec44 AC1: toFtsSafeText leaves no quote, backslash, or FTS operator character in any token', () => {
    for (const [, text] of HOSTILE) {
      const safe = toFtsSafeText(text);
      expect(safe).not.toMatch(/[^\p{L}\p{N}_ ]/u);
    }
    expect(toFtsSafeText('alpha AND beta')).toBe('alpha AND beta');
    expect(toFtsSafeText(String.raw`view:\'order\'`)).toBe('view order');
  });
});
