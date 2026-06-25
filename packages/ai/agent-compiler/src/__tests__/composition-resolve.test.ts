/**
 * composition-resolve.test.ts
 *
 * Drives resolveBody against a REAL on-disk SQLite file seeded with actual
 * agent-registry rows (never :memory:, never mocks — [inv:real-rows-not-mocks]).
 *
 * Proves:
 *   [composition-resolve.1] assembles body from resolveComposition in junction order
 *   [composition-resolve.2] body-ordering test passes
 *
 * Key invariants exercised:
 *   - body sections concatenated in ascending position order
 *   - context-conditioned component included when context matches
 *   - context-conditioned component excluded when context does NOT match
 *
 * NEGATIVE-CONTROL: resolveBody delegates ordering + filtering to a SINGLE
 * CompositionStore.resolveComposition call. Removing that call makes the
 * ordering + exclusion assertions fail — the single-delegated-call invariant
 * ([inv:context-precedence-consumed]) is what gives the test its teeth.
 *
 * Gate on the vitest EXIT CODE — better-sqlite3 can segfault at teardown
 * after a clean run (project memory feedback_plan_execution_pitfalls).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { AgentStore, ComponentStore, CompositionStore } from '@adhd/agent-registry';
import { resolveBody } from '../resolve/composition.js';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Path to the agent-registry drizzle migrations folder.
 * The compiler test opens the SHARED registry DB (which lives under the
 * registry_ prefix) — all the tables resolveBody touches are there.
 * agent-compiler has no compiler_* tables yet, so only registry migrations run.
 *
 * Path from packages/ai/agent-compiler/src/__tests__/:
 *   ../../../agent-registry/drizzle → packages/ai/agent-registry/drizzle
 */
const REGISTRY_MIGRATIONS = path.resolve(
  new URL(
    '../../../agent-registry/drizzle',
    import.meta.url
  ).pathname
);

interface OpenResult {
  conn: Database.Database;
  agentStore: AgentStore;
  componentStore: ComponentStore;
  compositionStore: CompositionStore;
}

/** Open a fresh handle, run ALL registry migrations, return stores. */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF'); // FK-safe migration pattern
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS });
  conn.pragma('foreign_keys = ON');

  return {
    conn,
    agentStore: new AgentStore(db),
    componentStore: new ComponentStore(db),
    compositionStore: new CompositionStore(db),
  };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('resolveBody', () => {
  let dbPath: string;
  let conn: Database.Database;
  let agentStore: AgentStore;
  let componentStore: ComponentStore;

  beforeAll(() => {
    // Real on-disk tmp file — never :memory: [inv:real-rows-not-mocks]
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-compiler-compose-test-')
    );
    dbPath = path.join(tmpDir, 'test-resolve.db');

    const opened = openDb(dbPath);
    conn = opened.conn;
    agentStore = opened.agentStore;
    componentStore = opened.componentStore;

    // ── Seed shared prompt type ─────────────────────────────────────────
    componentStore.upsertType({
      slug: 'system',
      description: 'System prompt section',
      isSystem: true,
    });

    // ── Seed agent ──────────────────────────────────────────────────────
    agentStore.create({
      slug: 'compile-agent',
      displayName: 'Compile Test Agent',
    });

    // ── Seed 3 components at distinct positions ─────────────────────────
    //
    // comp-intro  → position=1 (always-included)
    // comp-body   → position=2 (always-included)
    // comp-secure → position=3 (context-conditioned: { mode: "secure" })
    //
    // With context { mode: "secure" }  → all 3 included; body order: intro, body, secure.
    // With context { mode: "normal" }  → comp-secure excluded; body order: intro, body.

    componentStore.create({
      slug: 'comp-intro',
      type: 'system',
      content: 'INTRO TEXT',
    });
    componentStore.create({
      slug: 'comp-body',
      type: 'system',
      content: 'BODY TEXT',
    });
    componentStore.create({
      slug: 'comp-secure',
      type: 'system',
      content: 'SECURE TEXT',
    });

    // Attach junction rows using agent-registry CompositionStore API
    // [inv:real-rows-not-mocks]
    const compStore = opened.compositionStore;

    compStore.attach({
      agentSlug: 'compile-agent',
      componentSlug: 'comp-intro',
      position: 1,
    });
    compStore.attach({
      agentSlug: 'compile-agent',
      componentSlug: 'comp-body',
      position: 2,
    });
    compStore.attach({
      agentSlug: 'compile-agent',
      componentSlug: 'comp-secure',
      position: 3,
      contextCondition: JSON.stringify({ mode: 'secure' }),
    });

    // Close initial connection — the tests below reopen to prove persistence.
    conn.close();
  });

  afterAll(() => {
    // Close before unlinking — avoids WAL teardown race
    try { conn.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* ignore */ }
  });

  // ── [composition-resolve.1] + [composition-resolve.2] ─────────────────────

  describe('body assembly in junction order', () => {
    it('returns component texts concatenated in position order', () => {
      // Reopen from the SAME path — proves rows hit disk, not memory.
      // [inv:reopen-proves-cache] shape.
      const reopened = openDb(dbPath);
      conn = reopened.conn;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = drizzle(reopened.conn, { schema: {} as any });

      // Context matching the conditional component — all 3 should be included.
      const result = resolveBody(db, 'compile-agent', { mode: 'secure' });

      // body is sections joined by '\n' in position order: intro, body, secure.
      // NEGATIVE-CONTROL: if the delegated call is removed, resolveBody has no
      // data and body would be empty string — this assertion goes red.
      expect(result.body).toBe('INTRO TEXT\nBODY TEXT\nSECURE TEXT');

      // componentVersions map must contain all 3 slugs at version 1.
      expect(result.componentVersions['comp-intro']).toBe(1);
      expect(result.componentVersions['comp-body']).toBe(1);
      expect(result.componentVersions['comp-secure']).toBe(1);

      conn.close();
    });

    it('excludes the context-conditioned component when context does not match', () => {
      // Reopen again — each test gets a fresh handle.
      const reopened = openDb(dbPath);
      conn = reopened.conn;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = drizzle(reopened.conn, { schema: {} as any });

      // Context { mode: "normal" } → comp-secure condition {"mode":"secure"} does NOT match.
      // NEGATIVE-CONTROL: if the delegated filter call is removed, comp-secure
      // would be included and the body assertion goes red.
      const result = resolveBody(db, 'compile-agent', { mode: 'normal' });

      expect(result.body).toBe('INTRO TEXT\nBODY TEXT');

      // comp-secure must NOT appear in the version map.
      expect(Object.keys(result.componentVersions)).not.toContain('comp-secure');
      expect(result.componentVersions['comp-intro']).toBe(1);
      expect(result.componentVersions['comp-body']).toBe(1);

      conn.close();
    });

    it('returns empty body and empty version map for an agent with no components', () => {
      const reopened = openDb(dbPath);
      conn = reopened.conn;

      agentStore = reopened.agentStore;
      agentStore.create({
        slug: 'empty-agent',
        displayName: 'Empty Agent',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = drizzle(reopened.conn, { schema: {} as any });
      const result = resolveBody(db, 'empty-agent', {});

      expect(result.body).toBe('');
      expect(result.componentVersions).toEqual({});

      conn.close();
    });
  });
});
