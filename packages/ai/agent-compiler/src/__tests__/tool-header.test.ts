/**
 * tool-header.test.ts
 *
 * Drives resolveTools against a REAL on-disk SQLite file seeded with actual
 * agent-tool-registry rows (never :memory:, never mocks — [inv:real-rows-not-mocks]).
 *
 * Proves:
 *   [tool-header-emit.1] joins tool_platform_bindings to build platform tools header
 *   [tool-header-emit.2] resolved tools header test passes
 *
 * Negative-control invariants exercised:
 *   - [dod.1] the join MUST be platform-keyed: resolveTools('claude_code') returns
 *     PascalCase aliases ('Read','Grep','WebSearch'), NOT canonical names
 *     ('file_read','file_grep','web_search'); the same agent on 'claude_api'
 *     returns the claude_api aliases ('read_file','web_search').
 *   - 'unavailable' bindings are dropped: human_input seeded with
 *     availability='unavailable' on 'claude_api' must NOT appear in the result.
 *   - Persistence proven by closing the better-sqlite3 handle and REOPENING
 *     from the same on-disk path before the assertions run.
 *
 * Gate on the vitest EXIT CODE — better-sqlite3 can segfault at teardown
 * after a clean run (project memory feedback_plan_execution_pitfalls).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import {
  AgentToolStore,
  BindingStore,
  seed,
} from '@adhd/agent-tool-registry';

import { resolveTools } from '../resolve/tools.js';

// ── helpers ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Path to agent-tool-registry's drizzle migrations folder.
 * tool-header.test.ts lives at packages/ai/agent-compiler/src/__tests__/
 * agent-tool-registry drizzle lives at packages/ai/agent-tool-registry/drizzle/
 */
const TOOL_REGISTRY_MIGRATIONS = path.resolve(
  __dirname,
  '../../../agent-tool-registry/drizzle'
);

interface OpenResult {
  conn: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: ReturnType<typeof drizzle<any>>;
  agentToolStore: AgentToolStore;
  bindingStore: BindingStore;
}

/** Open a fresh better-sqlite3 handle, run migrations, return stores. */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF'); // FK-safe migration pattern (matches composition-resolve.test.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS });
  conn.pragma('foreign_keys = ON');

  return {
    conn,
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentToolStore: new AgentToolStore(db as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindingStore: new BindingStore(db as any),
  };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('resolveTools — platform tools header', () => {
  let dbPath: string;
  let tmpDir: string;
  let conn: Database.Database;

  beforeAll(() => {
    // Real on-disk tmp file — never :memory: ([inv:real-rows-not-mocks])
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-tool-header-'));
    dbPath = path.join(tmpDir, 'test-tool-header.db');

    const opened = openDb(dbPath);
    conn = opened.conn;

    // ── Seed the canonical tool catalog via agent-tool-registry's seed() ────
    // seed() inserts: tool_types → platforms → tools → tool_platform_bindings.
    // Idempotent ([inv:real-rows-not-mocks]: real rows, real FK-safe seed API).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seed(opened.db as any);

    // ── Grant tools to the test agent via AgentToolStore.grant() ────────────
    // Three grants: file_read, file_grep, web_search.
    // agent_slug is a logical reference — no agents table needed here.
    opened.agentToolStore.grant({ agentSlug: 'test-agent', toolName: 'file_read',  permission: 'full'      });
    opened.agentToolStore.grant({ agentSlug: 'test-agent', toolName: 'file_grep',  permission: 'read_only' });
    opened.agentToolStore.grant({ agentSlug: 'test-agent', toolName: 'web_search', permission: 'full'      });

    // ── Also grant human_input to test the unavailable-drop on claude_api ───
    opened.agentToolStore.grant({ agentSlug: 'test-agent', toolName: 'human_input', permission: 'full' });

    // Close the write connection.  The tests below reopen to prove persistence.
    conn.close();
  });

  afterAll(() => {
    try { conn.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(dbPath);           } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`);  } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`);  } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── [tool-header-emit.1] + [tool-header-emit.2] ────────────────────────────

  describe('[dod.1] platform-keyed join — claude_code aliases', () => {
    it('returns PascalCase claude_code aliases, NOT canonical names', () => {
      // Reopen from the SAME path — proves rows hit disk, not memory.
      // This is the [inv:reopen-proves-cache] pattern.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'test-agent', 'claude_code');

      // platformAlias values must be the claude_code PascalCase names —
      // NEGATIVE-CONTROL: if the platform filter is absent, resolveTools would
      // emit canonical names ('file_read', 'file_grep', 'web_search'); these
      // assertions go red.
      const aliases = results.map(r => r.platformAlias);
      expect(aliases).toContain('Read');
      expect(aliases).toContain('Grep');
      expect(aliases).toContain('WebSearch');

      // Canonical names must NOT appear in the alias list.
      expect(aliases).not.toContain('file_read');
      expect(aliases).not.toContain('file_grep');
      expect(aliases).not.toContain('web_search');

      // canonicalName field is present for inspection
      const canonicals = results.map(r => r.canonicalName);
      expect(canonicals).toContain('file_read');
      expect(canonicals).toContain('file_grep');
      expect(canonicals).toContain('web_search');

      conn.close();
    });

    it('human_input is available on claude_code (AskUserQuestion)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'test-agent', 'claude_code');
      const aliases = results.map(r => r.platformAlias);

      // human_input is seeded as 'available' on claude_code → alias 'AskUserQuestion'
      expect(aliases).toContain('AskUserQuestion');

      conn.close();
    });
  });

  describe('[dod.1] platform-keyed join — claude_api aliases', () => {
    it('returns claude_api snake_case aliases, NOT canonical names', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'test-agent', 'claude_api');

      const aliases = results.map(r => r.platformAlias);

      // file_read → read_file on claude_api
      expect(aliases).toContain('read_file');
      // web_search → web_search on claude_api (same name, different platform binding)
      expect(aliases).toContain('web_search');

      // Canonical names must NOT appear as alias values.
      expect(aliases).not.toContain('file_read');
      // 'file_grep' has no binding row on claude_api → should not appear at all.
      expect(aliases).not.toContain('file_grep');
      expect(aliases).not.toContain('Grep');

      conn.close();
    });

    it('drops human_input (unavailable on claude_api)', () => {
      // [dod.1] negative-control: human_input is seeded with
      // availability='unavailable' on claude_api. resolveTools MUST drop it.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'test-agent', 'claude_api');

      // Neither the alias ('') nor the canonical name ('human_input') should appear.
      const aliases    = results.map(r => r.platformAlias);
      const canonicals = results.map(r => r.canonicalName);
      expect(aliases).not.toContain('');
      expect(canonicals).not.toContain('human_input');

      conn.close();
    });
  });

  describe('persistence — close + reopen proves disk write', () => {
    it('results are identical across independent connections', () => {
      // First connection
      const { conn: c1, db: db1 } = openDb(dbPath);
      const first = resolveTools(db1, 'test-agent', 'claude_code').map(r => r.platformAlias);
      c1.close();

      // Second fresh connection from same file
      const { conn: c2, db: db2 } = openDb(dbPath);
      const second = resolveTools(db2, 'test-agent', 'claude_code').map(r => r.platformAlias);
      conn = c2;
      c2.close();

      // Teeth: if the grants weren't flushed to disk the second run would return [].
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for an agent with no grants', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'no-such-agent', 'claude_code');
      expect(results).toEqual([]);

      conn.close();
    });

    it('returns only available tools (no unavailable bindings included)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const results = resolveTools(db, 'test-agent', 'claude_api');

      for (const r of results) {
        expect(r.availability).not.toBe('unavailable');
      }

      conn.close();
    });
  });
});
