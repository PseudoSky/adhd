/**
 * registry.test.ts — d3f1f787 / b578a483 (D-G(1)) ProviderRegistry.
 *
 * Drives the REAL registry over a REAL on-disk SQLite DB (migrations applied,
 * real `seed()` data), reopened after seeding so persistence — not an
 * in-memory write — is what is asserted.
 *
 * AC mapping (the ticket's single AC sentence split into numbered clauses):
 *   d3f1f787 AC1 — resolveModelRef('claude_sonnet_4_6','claude_api') === 'claude-sonnet-4-6'
 *   d3f1f787 AC2 — toolFormatLookup('anthropic','web_search') is the server_side row
 *   d3f1f787 AC3 — negative control: the platform filter separates platforms
 *                  (asserted on BOTH platforms in one test; the NC run removes
 *                  the filter in ModelStore.resolveModelId and this goes red)
 *   (AC4 — snake_case-gone / dag migration — lives in dispatch-serializer-json)
 *
 * NOTE: `seed()` does not seed `provider_tool_formats` (D-G(3) segment F).
 * AC2 inserts the anthropic web_search row through the real ToolFormatStore.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrationsOn } from '../db/migrate-runner.js';
import * as schema from '../db/schema.js';
import { emitToolsForProvider } from '../runtime/emit-tools.js';
import { createProviderRegistry, type ProviderRegistryDb } from '../registry.js';
import { seed } from '../seed/index.js';
import { ModelStoreError } from '../store/model-store.js';
import { ToolFormatStore } from '../store/tool-format-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../../drizzle');

function openDb(dbPath: string): {
  sqlite: Database.Database;
  db: ProviderRegistryDb;
} {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any as ProviderRegistryDb;
  runMigrationsOn(sqlite, db, migrationsFolder);
  return { sqlite, db };
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-registry-test-'));
  dbPath = path.join(tmpDir, 'registry.db');
  const first = openDb(dbPath);
  seed(first.db);
  new ToolFormatStore(first.db).create({
    providerId: 'anthropic',
    canonicalTool: 'web_search',
    emitShape: 'server_side',
    typeTag: 'web_search_20250305',
  });
  first.sqlite.close();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ProviderRegistry (d3f1f787)', () => {
  it('d3f1f787 AC1 — resolveModelRef maps a canonical ref to the claude_api wire string', () => {
    const { sqlite, db } = openDb(dbPath);
    try {
      const registry = createProviderRegistry(db);
      expect(registry.resolveModelRef('claude_sonnet_4_6', 'claude_api')).toBe(
        'claude-sonnet-4-6'
      );
    } finally {
      sqlite.close();
    }
  });

  it('d3f1f787 AC2 — toolFormatLookup returns the server_side row and feeds the emitter', () => {
    const { sqlite, db } = openDb(dbPath);
    try {
      const registry = createProviderRegistry(db);
      const row = registry.toolFormatLookup('anthropic', 'web_search');
      expect(row?.emitShape).toBe('server_side');
      expect(row?.typeTag).toBe('web_search_20250305');
      expect(registry.toolFormatLookup('anthropic', 'nope')).toBeNull();

      const emitted = emitToolsForProvider(
        [{ name: 'web_search', description: 'search', inputSchema: {} }],
        'anthropic',
        registry.toolFormatLookup
      );
      expect(emitted).toEqual([
        { type: 'web_search_20250305', name: 'web_search' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('d3f1f787 AC3 — platform filter: each platform gets its OWN string, unknown pair throws', () => {
    const { sqlite, db } = openDb(dbPath);
    try {
      const registry = createProviderRegistry(db);
      expect(registry.resolveModelRef('claude_sonnet_4_6', 'claude_api')).toBe(
        'claude-sonnet-4-6'
      );
      expect(registry.resolveModelRef('claude_sonnet_4_6', 'claude_code')).toBe(
        'sonnet'
      );
      expect(registry.resolveModelRef('claude_opus_4_8', 'claude_code')).toBe(
        'opus'
      );
      expect(registry.resolveModelRef('claude_opus_4_8', 'claude_api')).toBe(
        'claude-opus-4-8'
      );
      expect(() =>
        registry.resolveModelRef('claude_sonnet_4_6', 'no_such_platform')
      ).toThrow(ModelStoreError);
    } finally {
      sqlite.close();
    }
  });

  it('list()/get() expose the seeded providers; get() of an unknown id is null', () => {
    const { sqlite, db } = openDb(dbPath);
    try {
      const registry = createProviderRegistry(db);
      expect(registry.list().map((p) => p.id)).toEqual(
        expect.arrayContaining(['anthropic', 'openai', 'claudecli'])
      );
      expect(registry.get('anthropic')?.transport).toBe('HTTP');
      expect(registry.get('does-not-exist')).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
