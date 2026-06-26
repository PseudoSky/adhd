/**
 * model-policy.test.ts
 *
 * Drives resolveModel + resolvePolicyConstraints against a REAL on-disk SQLite
 * file seeded via the upstream packages' store and seed APIs — never :memory:,
 * never mocks ([inv:real-rows-not-mocks]).
 *
 * Proves:
 *   [model-and-policy-emit.1] resolves model_hint via model_platform_bindings
 *   [model-and-policy-emit.2] folds agent_policy rows into header/body block
 *   [model-and-policy-emit.3] model+policy resolution test passes
 *
 * Invariants exercised:
 *   - resolveModel('claude_code') returns the short alias ('opus'), not the
 *     canonical id ('claude_opus_4_8') — negative-control: without the platform
 *     filter in ModelStore.resolveModelId this assertion goes red.
 *   - resolveModel('claude_api') returns the full id ('claude-opus-4-8').
 *   - resolvePolicyConstraints returns a non-empty list including the
 *     'no-credentials' constraint when that policy is attached to the agent.
 *   - Persistence proven by closing the handle and REOPENING from the same path
 *     before assertions run ([inv:reopen-proves-cache] shape).
 *   - Inherited-policy assertion: a policy attached to a taxonomy category
 *     resolves onto the agent via resolveForAgent (3-query merge).
 *   - [dod.3] negative-control: an agent with NO policies returns [] from
 *     resolvePolicyConstraints — the constraint block is keyed exclusively on
 *     agent_policy rows, not on hardcoded per-slug branches.
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

// Upstream store + seed APIs ([inv:real-rows-not-mocks])
import { AgentStore, TaxonomyStore } from '@adhd/agent-registry';
import { ModelStore, seed as seedProvider } from '@adhd/agent-provider';
import {
  AgentPolicyStore,
  PolicyTemplateStore,
  seed as seedPolicy,
} from '@adhd/agent-policy';

// Under test
import { resolveModel } from '../resolve/model.js';
import { resolvePolicyConstraints } from '../resolve/policy.js';

// ── helpers ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Migration folder paths relative to this test file.
 * Packages share one SQLite file — all three prefix sets must be migrated.
 *
 * test file: packages/ai/agent-compiler/src/__tests__/
 *   ../../../agent-registry/drizzle  → packages/ai/agent-registry/drizzle
 *   ../../../agent-provider/drizzle  → packages/ai/agent-provider/drizzle
 *   ../../../agent-policy/drizzle    → packages/ai/agent-policy/drizzle
 *
 * ORDER MATTERS: Drizzle's migrator skips files whose journal `when` timestamp
 * is <= the last recorded migration.  Provider journals use 1750* timestamps,
 * registry + policy use 1782* — so provider MUST migrate before registry or
 * its migrations look "already applied" and are silently skipped.
 * Correct order: provider (1750*) → registry (1782*) → policy (1782*).
 */
const PROVIDER_MIGRATIONS = path.resolve(
  __dirname,
  '../../../agent-provider/drizzle'
);
const REGISTRY_MIGRATIONS = path.resolve(
  __dirname,
  '../../../agent-registry/drizzle'
);
const POLICY_MIGRATIONS = path.resolve(
  __dirname,
  '../../../agent-policy/drizzle'
);

interface OpenResult {
  conn:   Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:     ReturnType<typeof drizzle<any>>;
}

/**
 * Open a fresh better-sqlite3 handle, run ALL three prefix migrations (registry_*,
 * provider_*, policy_*) so every table exists on the shared DB.  Returns the
 * connection and the Drizzle handle.
 *
 * FK-safe pattern: disable FKs during migration, re-enable after.
 */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  // Provider FIRST (1750* timestamps), then registry + policy (1782* timestamps).
  // Drizzle's migrator skips entries whose `when` <= last recorded timestamp —
  // running provider after registry would silently skip all provider tables.
  migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS });
  migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS });
  migrate(db, { migrationsFolder: POLICY_MIGRATIONS });
  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('resolveModel + resolvePolicyConstraints', () => {
  let dbPath: string;
  let tmpDir: string;
  let conn: Database.Database;

  // Test slugs
  const AGENT_SLUG     = 'compiler-test-agent';
  const CATEGORY_SLUG  = 'test-category';
  const MODEL_HINT     = 'claude_opus_4_8';

  beforeAll(() => {
    // Real on-disk tmp file — never :memory: ([inv:real-rows-not-mocks])
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-model-policy-'));
    dbPath = path.join(tmpDir, 'test-model-policy.db');

    const { conn: c, db } = openDb(dbPath);
    conn = c;

    // ── 1. Seed provider catalog (models + bindings) ────────────────────────
    // seedProvider inserts providers → models → model_platform_bindings.
    // Idempotent ([inv:real-rows-not-mocks]).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);

    // ── 2. Seed policy templates ────────────────────────────────────────────
    // seedPolicy inserts policy_types → policy_templates.  Idempotent.
    seedPolicy(db);

    // ── 3. Seed the taxonomy category the agent will belong to ──────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taxonomyStore = new TaxonomyStore(db as any);
    taxonomyStore.createCategory({
      slug: CATEGORY_SLUG,
      name: 'Test Category',
    });

    // ── 4. Seed the test agent with model_hint: claude_opus_4_8 ────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentStore = new AgentStore(db as any);
    agentStore.create({
      slug:        AGENT_SLUG,
      displayName: 'Compiler Test Agent',
      modelHint:   MODEL_HINT,
      taxonomyCategory: CATEGORY_SLUG,
    });

    // ── 5. Attach no-credentials policy directly to the agent ───────────────
    const agentPolicyStore = new AgentPolicyStore(db);
    agentPolicyStore.attach({
      agentSlug:  AGENT_SLUG,
      policySlug: 'no-credentials',
    });

    // ── 6. Attach reviewer-posture to the CATEGORY (inherited-policy path) ──
    agentPolicyStore.attachToCategory({
      categorySlug: CATEGORY_SLUG,
      policySlug:   'reviewer-posture',
    });
    agentPolicyStore.addAgentToCategory({
      agentSlug:    AGENT_SLUG,
      categorySlug: CATEGORY_SLUG,
    });

    // Close write connection — tests reopen to prove persistence.
    conn.close();
  });

  afterAll(() => {
    try { conn.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(dbPath);           } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`);  } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`);  } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── [model-and-policy-emit.1] resolves model_hint via model_platform_bindings ──

  describe('[model-and-policy-emit.1] model resolution', () => {
    it('resolveModel on claude_code returns the short alias "opus"', () => {
      // Reopen from the SAME path — proves rows hit disk, not memory.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // NEGATIVE-CONTROL: without the platform filter in ModelStore.resolveModelId,
      // this would return the first binding row for any platform, not 'opus'.
      const result = resolveModel(db, AGENT_SLUG, 'claude_code');
      expect(result).toBe('opus');

      conn.close();
    });

    it('resolveModel on claude_api returns the full id "claude-opus-4-8"', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = resolveModel(db, AGENT_SLUG, 'claude_api');
      expect(result).toBe('claude-opus-4-8');

      conn.close();
    });

    it('two platforms return DIFFERENT values for the same model_hint', () => {
      // This is the core platform-keyed invariant — same agent, different platform.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const codeAlias = resolveModel(db, AGENT_SLUG, 'claude_code');
      const apiId     = resolveModel(db, AGENT_SLUG, 'claude_api');

      expect(codeAlias).not.toBe(apiId);
      expect(codeAlias).toBe('opus');
      expect(apiId).toBe('claude-opus-4-8');

      conn.close();
    });

    it('returns empty string for an agent with no model_hint', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // Seed an agent with no model_hint.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentStore = new AgentStore(db as any);
      agentStore.create({
        slug:        'no-model-agent',
        displayName: 'No Model Agent',
      });

      const result = resolveModel(db, 'no-model-agent', 'claude_code');
      expect(result).toBe('');

      conn.close();
    });
  });

  // ── [model-and-policy-emit.2] folds agent_policy rows into header/body block ──

  describe('[model-and-policy-emit.2] policy constraint resolution', () => {
    it('resolvePolicyConstraints includes the no-credentials constraint', () => {
      // Reopen from the SAME path — persistence proof.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const constraints = resolvePolicyConstraints(db, AGENT_SLUG);

      // Must include the no-credentials constraint.
      const noCredentials = constraints.find(c => c.policySlug === 'no-credentials');
      expect(noCredentials).toBeDefined();
      // Constraint text must be non-empty — it's the human-readable description.
      expect(noCredentials?.text.length).toBeGreaterThan(0);
      // The no-credentials template description should reflect the policy.
      expect(noCredentials?.text).toMatch(/credential|leak/i);

      conn.close();
    });

    it('includes the inherited reviewer-posture constraint (category inheritance)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const constraints = resolvePolicyConstraints(db, AGENT_SLUG);

      // reviewer-posture was attached to the category, not directly to the agent.
      const reviewer = constraints.find(c => c.policySlug === 'reviewer-posture');
      expect(reviewer).toBeDefined();
      // inheritedFrom must be the category slug, not null.
      expect(reviewer?.inheritedFrom).toBe(CATEGORY_SLUG);
      expect(reviewer?.text.length).toBeGreaterThan(0);

      conn.close();
    });

    it('direct-attach has inheritedFrom = null', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const constraints = resolvePolicyConstraints(db, AGENT_SLUG);
      const noCredentials = constraints.find(c => c.policySlug === 'no-credentials');

      // Direct-attach: inheritedFrom is null.
      expect(noCredentials?.inheritedFrom).toBeNull();

      conn.close();
    });

    it('[dod.3] returns empty array for an agent with no policies', () => {
      // NEGATIVE-CONTROL: if resolvePolicyConstraints had hardcoded per-slug
      // branches, an agent with no policies could still return something — this
      // assertion makes that bites.  The constraint block is EXCLUSIVELY keyed
      // on agent_policy rows.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // Seed an agent with no attached policies.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentStore = new AgentStore(db as any);
      agentStore.create({
        slug:        'no-policy-agent',
        displayName: 'No Policy Agent',
      });

      const constraints = resolvePolicyConstraints(db, 'no-policy-agent');
      expect(constraints).toEqual([]);

      conn.close();
    });
  });

  // ── Persistence — close + reopen proves disk write ─────────────────────────

  describe('persistence — close + reopen proves disk write', () => {
    it('model resolution is identical across independent connections', () => {
      const { conn: c1, db: db1 } = openDb(dbPath);
      const first = resolveModel(db1, AGENT_SLUG, 'claude_code');
      c1.close();

      const { conn: c2, db: db2 } = openDb(dbPath);
      const second = resolveModel(db2, AGENT_SLUG, 'claude_code');
      conn = c2;
      c2.close();

      // Teeth: if model rows weren't flushed to disk, second would be '' (no agent).
      expect(first).toBe('opus');
      expect(second).toBe('opus');
    });

    it('policy constraints are identical across independent connections', () => {
      const { conn: c1, db: db1 } = openDb(dbPath);
      const first = resolvePolicyConstraints(db1, AGENT_SLUG).map(c => c.policySlug);
      c1.close();

      const { conn: c2, db: db2 } = openDb(dbPath);
      const second = resolvePolicyConstraints(db2, AGENT_SLUG).map(c => c.policySlug);
      conn = c2;
      c2.close();

      // Teeth: if policy rows weren't flushed, both would be [].
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    });
  });
});
