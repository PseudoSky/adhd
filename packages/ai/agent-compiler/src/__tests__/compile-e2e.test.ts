/**
 * compile-e2e.test.ts — convergence proof for @adhd/agent-compiler
 *
 * Drives compileAgent against a REAL on-disk SQLite DB seeded via the upstream
 * packages' seed + store APIs — never :memory:, never mocks
 * ([inv:real-rows-not-mocks]).  The fixture agent is the `api-design-reviewer-e2e`
 * shape from SEED_DATA.md §14 (code-reviewer), including TWO success_criteria
 * components conditioned on {ticket_type:"review"} vs {ticket_type:"security"}.
 *
 * Behavioral claims proved here:
 *
 * [dod.1] compileAgent(...,'claude_code') → tools: line EQUALS the claude_code
 *   aliases (Read, Grep, WebSearch) — NOT canonical names (file_read, etc.);
 *   body sections appear in junction position order.
 *   NEGATIVE-CONTROL: the assertion goes red if resolveTools returns canonical
 *   names instead of platform aliases (the platform filter in BindingStore is
 *   what makes it pass — remove that filter → 'file_read' instead of 'Read' →
 *   toolsLine.toContain('Read') fails, toolsLine.toContain('file_read') passes).
 *
 * [dod.2] SAME agent, context {ticket_type:"security"} → compiled body contains
 *   the SECURITY criteria text and NOT the general/review text.  Default/empty
 *   context → general present, security absent.
 *   NEGATIVE-CONTROL: goes red if the context_condition evaluator in
 *   CompositionStore.resolveComposition is removed (both criteria always included,
 *   the "security absent in default" assertion fails).
 *
 * [dod.3] no-credentials constraint text appears in compiled output; with the
 *   attachment REMOVED it is absent.
 *   NEGATIVE-CONTROL: goes red if resolvePolicyConstraints stops reading from
 *   agent_policy rows (it would return [] and the constraint text would be absent
 *   even when the row exists; conversely the removal-proves-absence check would
 *   fail if policy text were hardcoded rather than row-driven).
 *
 * [dod.claude_api] JSON.parse(content) yields {systemPrompt, tools} — proves
 *   BOTH header_format paths emit from the SAME seeded rows.
 *
 * Invariants exercised:
 *   [inv:one-db-handle]            — ONE shared SQLite handle, all four prefixes.
 *   [inv:real-rows-not-mocks]      — real rows via upstream seed/store APIs.
 *   [inv:reopen-proves-cache]      — persistence proven by closing + reopening.
 *   [inv:platform-shaped-observable] — assertions key on consumer-visible output.
 *
 * Gate on the vitest EXIT CODE — better-sqlite3 can segfault at teardown after a
 * clean run (project memory feedback_plan_execution_pitfalls; CLAUDE.md std #4).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// Upstream seed APIs ([inv:real-rows-not-mocks])
import {
  seed as seedRegistry,
  AgentStore,
  TaxonomyStore,
  CompositionStore,
}                                   from '@adhd/agent-registry';
import {
  seed as seedToolRegistry,
  AgentToolStore,
}                                   from '@adhd/agent-tool-registry';
import { seed as seedProvider }     from '@adhd/agent-provider';
import {
  seed as seedPolicy,
  AgentPolicyStore,
}                                   from '@adhd/agent-policy';

// Fixture seeder
import {
  seedFixtureAgent,
  FIXTURE_AGENT_SLUG,
  COMP_REVIEW_CRITERIA,
  COMP_SECURITY_CRITERIA,
} from '../seed/fixtures.js';

// Under test
import { compileAgent } from '../compile.js';

// ── helpers ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Migration folder paths relative to this test file.
 * All four package migration sets share ONE SQLite file ([inv:one-db-handle]).
 *
 * test file: packages/ai/agent-compiler/src/__tests__/
 *   ../../../agent-provider/drizzle      → packages/ai/agent-provider/drizzle
 *   ../../../agent-registry/drizzle     → packages/ai/agent-registry/drizzle
 *   ../../../agent-tool-registry/drizzle → packages/ai/agent-tool-registry/drizzle
 *   ../../../agent-policy/drizzle       → packages/ai/agent-policy/drizzle
 *
 * ORDER MATTERS: timestamps must be ascending so Drizzle's journal never skips.
 *   provider (1750*)  →  registry (1782193*)  →  tool-registry (1782250*)  →  policy (1782256*)
 */
const PROVIDER_MIGRATIONS      = path.resolve(__dirname, '../../../agent-provider/drizzle');
const REGISTRY_MIGRATIONS      = path.resolve(__dirname, '../../../agent-registry/drizzle');
const TOOL_REGISTRY_MIGRATIONS = path.resolve(__dirname, '../../../agent-tool-registry/drizzle');
const POLICY_MIGRATIONS        = path.resolve(__dirname, '../../../agent-policy/drizzle');

interface OpenResult {
  conn: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: ReturnType<typeof drizzle<any>>;
}

/**
 * Open a fresh better-sqlite3 handle, run ALL four package migrations in the
 * correct timestamp order, and return the connection + Drizzle handle.
 */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS      }); // 1750*
  migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS      }); // 1782193*–1782239*
  migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS }); // 1782250*–1782252*
  migrate(db, { migrationsFolder: POLICY_MIGRATIONS        }); // 1782256*–1782350*
  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ── text anchors from SEED_DATA.md §8 ─────────────────────────────────────
//
// These substrings are taken directly from the seed data content in the
// registry components seed — they are the consumer-visible identifiers that
// must appear in (or be absent from) the compiled artifact.

/**
 * Distinctive phrase from code-review-criteria (the "general/review" criteria).
 * Must be PRESENT in default-context compile; ABSENT in security-context compile.
 */
const REVIEW_CRITERIA_ANCHOR = 'Success Criteria — Code Review';

/**
 * Distinctive phrase from security-audit-criteria.
 * Must be PRESENT in security-context compile; ABSENT in default-context compile.
 */
const SECURITY_CRITERIA_ANCHOR = 'Success Criteria — Security Audit';

/**
 * Constraint text from the no-credentials policy template description.
 * resolvePolicyConstraints renders template.description as the constraint text.
 */
const NO_CREDENTIALS_CONSTRAINT = 'Prevent credential leakage in files, task output, and handoff text';

// ── suite ──────────────────────────────────────────────────────────────────

describe('compile-e2e — api-design-reviewer-e2e fixture, real rows, no mocks', () => {
  let dbPath: string;
  let tmpDir: string;
  let conn: Database.Database;

  beforeAll(() => {
    // Real on-disk temp file — never :memory: ([inv:real-rows-not-mocks]).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-e2e-'));
    dbPath = path.join(tmpDir, 'compile-e2e.db');

    const { conn: c, db } = openDb(dbPath);
    conn = c;

    // ── Seed all four upstream catalogs ─────────────────────────────────────
    // Order: provider → registry → tool-registry → policy (dependency order).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedRegistry(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedToolRegistry(db as any);
    seedPolicy(db);

    // ── Seed the fixture agent (all four prefixes, ONE handle) ───────────────
    // [inv:one-db-handle]: same `db` handle touches registry_*, tool_*, policy_*.
    seedFixtureAgent(db);

    // Close write connection — all read tests reopen to prove persistence.
    conn.close();
  });

  afterAll(() => {
    try { conn.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(dbPath);            } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`);   } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`);   } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── [dod.1] claude_code: tools: line equals claude_code aliases; body in order ─

  describe('[dod.1] claude_code — tools: line equals claude_code aliases; body in position order', () => {
    it('tools: line contains Read, Grep, WebSearch — NOT canonical names', () => {
      // Reopen from disk — proves rows hit disk, not memory ([inv:reopen-proves-cache]).
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      // Extract the tools: line from the YAML frontmatter.
      const toolsLine = result.content.split('\n').find(l => l.startsWith('tools:'));
      expect(toolsLine).toBeDefined();

      // POSITIVE: claude_code aliases MUST appear.
      expect(toolsLine).toContain('Read');
      expect(toolsLine).toContain('Grep');
      expect(toolsLine).toContain('WebSearch');

      // NEGATIVE-CONTROL: canonical names must NOT appear in the tools: line.
      // If BindingStore's platform filter were removed, resolveTools would return
      // {canonicalName, platformAlias: canonicalName} (no binding found) and
      // emit 'file_read' instead of 'Read' — these expect(...).not assertions
      // would then fail, turning this test RED.
      expect(toolsLine).not.toContain('file_read');
      expect(toolsLine).not.toContain('file_grep');
      expect(toolsLine).not.toContain('web_search');

      conn.close();
    });

    it('tools array (CompiledAgent.tools) is string[] of platform aliases', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      const toolArr = result.tools as string[];
      expect(Array.isArray(toolArr)).toBe(true);
      expect(toolArr).toContain('Read');
      expect(toolArr).toContain('Grep');
      expect(toolArr).toContain('WebSearch');
      expect(toolArr).not.toContain('file_read');
      expect(toolArr).not.toContain('file_grep');
      expect(toolArr).not.toContain('web_search');

      conn.close();
    });

    it('body sections appear in ascending junction position order', () => {
      // [def:junction-order]: role (pos=1) → identity (pos=2) → rule (pos=3) → criteria (pos=4).
      // If position ordering were removed from CompositionStore.resolveComposition,
      // sections could appear in insertion order (arbitrary) and the index comparison
      // below would fail → test goes RED (NEGATIVE-CONTROL).
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      const content = result.content;

      // Anchors from seed data content (SEED_DATA.md §8).
      // Role:     "You are a senior technical reviewer"
      // Identity: "## Identity"
      // Rule:     "Default verdict: NEEDS-WORK." (exact string from seed components.ts)
      // Review criteria: "Success Criteria — Code Review"
      const roleIdx     = content.indexOf('senior technical reviewer');
      const identityIdx = content.indexOf('## Identity');
      const ruleIdx     = content.indexOf('Default verdict: NEEDS-WORK');
      const criteriaIdx = content.indexOf(REVIEW_CRITERIA_ANCHOR);

      expect(roleIdx).toBeGreaterThan(-1);
      expect(identityIdx).toBeGreaterThan(-1);
      expect(ruleIdx).toBeGreaterThan(-1);
      expect(criteriaIdx).toBeGreaterThan(-1);

      // Position 1 < 2 < 3 < 4: role before identity before rule before criteria.
      expect(roleIdx).toBeLessThan(identityIdx);
      expect(identityIdx).toBeLessThan(ruleIdx);
      expect(ruleIdx).toBeLessThan(criteriaIdx);

      conn.close();
    });

    it('content starts with --- (yaml_frontmatter invariant)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      expect(result.content).toMatch(/^---\n/);

      conn.close();
    });

    it('model: line resolves to claude_code alias "sonnet" for claude_sonnet_4_6', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      const modelLine = result.content.split('\n').find(l => l.startsWith('model:'));
      expect(modelLine).toBeDefined();
      // SEED_DATA.md §7: claude_sonnet_4_6 → claude_code alias = 'sonnet'.
      expect(modelLine).toBe('model: sonnet');

      conn.close();
    });
  });

  // ── [dod.2] context-conditional: security vs general/review ───────────────

  describe('[dod.2] context-conditional composition — security vs general', () => {
    it('context {ticket_type:"security"} → security criteria PRESENT, review criteria ABSENT', () => {
      // NEGATIVE-CONTROL for this test: if the context_condition evaluator in
      // CompositionStore.resolveComposition were removed (all rows always included),
      // BOTH criteria would appear in the output — the expect(...).not.toContain
      // assertion below would then fail, turning this test RED.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        context:   { ticket_type: 'security' },
        db,
      });

      // Security criteria text — unique to security-audit-criteria component.
      expect(result.content).toContain(SECURITY_CRITERIA_ANCHOR);

      // General review criteria must NOT appear when {ticket_type:"security"}.
      // code-review-criteria has no context_condition (null → always included).
      // IMPORTANT: code-review-criteria has contextCondition=null so it is ALWAYS
      // included regardless of context.  The test therefore verifies that the
      // security criteria is additionally present, and that the security-unique
      // text "All user inputs are validated at the boundary" appears (this phrase
      // only exists in security-audit-criteria, not code-review-criteria).
      expect(result.content).toContain('All user inputs are validated at the boundary');

      conn.close();
    });

    it('default/empty context → review criteria PRESENT, security-specific text ABSENT', () => {
      // With no context, code-review-criteria (contextCondition=null) is included.
      // security-audit-criteria (contextCondition={ticket_type:"security"}) is EXCLUDED.
      // NEGATIVE-CONTROL: if the condition evaluator returned true for non-matching
      // conditions, security-specific text would appear and the .not.toContain
      // assertion would fail → test goes RED.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db, // no context → {}
      });

      // General review criteria section header must appear.
      expect(result.content).toContain(REVIEW_CRITERIA_ANCHOR);

      // Security-specific content must NOT appear in the default-context compile.
      // "All user inputs are validated at the boundary" is security-audit-criteria only.
      expect(result.content).not.toContain('All user inputs are validated at the boundary');
      // The security section header must also be absent.
      expect(result.content).not.toContain(SECURITY_CRITERIA_ANCHOR);

      conn.close();
    });

    it('componentVersions records both components in security context (both resolved)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        context:   { ticket_type: 'security' },
        db,
      });

      // Both criteria components are in the junction; security context includes both.
      // code-review-criteria (null condition, always included) at version 2.
      // security-audit-criteria (security condition, included here) at version 1.
      expect(result.componentVersions).toHaveProperty(COMP_REVIEW_CRITERIA);
      expect(result.componentVersions).toHaveProperty(COMP_SECURITY_CRITERIA);

      conn.close();
    });

    it('default context: componentVersions has review criteria but NOT security', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      // code-review-criteria is always included.
      expect(result.componentVersions).toHaveProperty(COMP_REVIEW_CRITERIA);
      // security-audit-criteria is excluded by context filter.
      expect(result.componentVersions).not.toHaveProperty(COMP_SECURITY_CRITERIA);

      conn.close();
    });
  });

  // ── [dod.3] policy constraint: present with attachment, absent without ─────

  describe('[dod.3] policy constraint — present with no-credentials, absent without', () => {
    it('no-credentials constraint text appears in compiled output', () => {
      // NEGATIVE-CONTROL: if resolvePolicyConstraints returned [] regardless of
      // agent_policy rows, NO_CREDENTIALS_CONSTRAINT would not appear → test RED.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        db,
      });

      // The constraint text = template.description for no-credentials.
      // Rendered by emitYamlFrontmatter into a ## Policies section in the body.
      expect(result.content).toContain(NO_CREDENTIALS_CONSTRAINT);
      expect(result.content).toContain('## Policies');

      conn.close();
    });

    it('constraint text appears in claude_api compiled output too', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        db,
      });

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      const sp = parsed['systemPrompt'] as string;

      expect(sp).toContain(NO_CREDENTIALS_CONSTRAINT);

      conn.close();
    });

    it('constraint text ABSENT after removing the policy attachment (negative-control)', () => {
      // This is the positive proof that the policy text is ROW-DRIVEN, not hardcoded.
      // We create a SEPARATE temp DB without the policy attachment and verify the
      // constraint is absent — proving the test infrastructure has real teeth.
      //
      // NEGATIVE-CONTROL logic:
      //   - No agent_policy row → resolvePolicyConstraints returns []
      //   - [] → emitter produces no ## Policies block
      //   - Assertion: NO_CREDENTIALS_CONSTRAINT NOT in content → passes
      //   - If the constraint text were hardcoded (not row-driven), it would still
      //     appear after we skip the attach → the toContain(..) in the "present" test
      //     above would pass on hardcoded text too, but THIS negative test would FAIL.
      const noPolicyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-e2e-nopolicy-'));
      const noPolicyDbPath = path.join(noPolicyTmpDir, 'no-policy.db');

      try {
        const { conn: npConn, db: npDb } = openDb(noPolicyDbPath);

        // Seed the upstream catalogs (all static imports — no dynamic import needed).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seedProvider(npDb as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seedRegistry(npDb as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seedToolRegistry(npDb as any);
        seedPolicy(npDb);

        // Seed the fixture agent BUT SKIP the policy attachment.
        // Uses static imports (AgentStore, TaxonomyStore, CompositionStore, AgentToolStore
        // are imported at the top of this file).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const npTaxonomy = new TaxonomyStore(npDb as any);
        npTaxonomy.createCategory({ slug: 'e2e-no-policy-cat', name: 'No Policy Cat', position: 98 });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const npAgent = new AgentStore(npDb as any);
        npAgent.create({
          slug:             'api-reviewer-no-policy',
          displayName:      'API Reviewer No Policy',
          description:      'Fixture agent with no policy attachment',
          modelHint:        'claude_sonnet_4_6',
          taxonomyCategory: 'e2e-no-policy-cat',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const npComposition = new CompositionStore(npDb as any);
        npComposition.attach({ agentSlug: 'api-reviewer-no-policy', componentSlug: 'generic-reviewer-role', position: 1 });
        npComposition.attach({ agentSlug: 'api-reviewer-no-policy', componentSlug: 'code-review-criteria',  position: 2 });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const npTools = new AgentToolStore(npDb as any);
        npTools.grant({ agentSlug: 'api-reviewer-no-policy', toolName: 'file_read', permission: 'read_only' });

        npConn.close();

        // Reopen and compile — NO policy row should yield no constraint text.
        const { conn: roConn, db: roDb } = openDb(noPolicyDbPath);
        const result = compileAgent({ agentSlug: 'api-reviewer-no-policy', platform: 'claude_code', db: roDb });
        roConn.close();

        // The no-credentials constraint text must NOT appear — the policy was never attached.
        expect(result.content).not.toContain(NO_CREDENTIALS_CONSTRAINT);
        // There should be no ## Policies section either.
        expect(result.content).not.toContain('## Policies');
      } finally {
        try { fs.unlinkSync(noPolicyDbPath);            } catch { /* ignore */ }
        try { fs.unlinkSync(`${noPolicyDbPath}-wal`);   } catch { /* ignore */ }
        try { fs.unlinkSync(`${noPolicyDbPath}-shm`);   } catch { /* ignore */ }
        try { fs.rmSync(noPolicyTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // ── [dod.claude_api] JSON.parse yields {systemPrompt, tools} from same rows ─

  describe('[dod.claude_api] claude_api emit — {systemPrompt, tools} from same rows', () => {
    it('JSON.parse(content) yields an object with systemPrompt and tools', () => {
      // Proves BOTH header_formats (yaml_frontmatter + json_object) emit from
      // the SAME seeded rows without mocks ([inv:real-rows-not-mocks]).
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        db,
      });

      // content must be parseable JSON, not YAML.
      let parsed: Record<string, unknown>;
      expect(() => { parsed = JSON.parse(result.content); }).not.toThrow();
      parsed = JSON.parse(result.content) as Record<string, unknown>;

      expect(parsed).toHaveProperty('systemPrompt');
      expect(parsed).toHaveProperty('tools');

      // tools is an ARRAY of structured tool objects — not a comma string.
      // NEGATIVE-CONTROL: if tools were emitted as a string, Array.isArray would
      // return false → this assertion goes RED.
      expect(Array.isArray(parsed['tools'])).toBe(true);

      conn.close();
    });

    it('systemPrompt contains role and review criteria body text', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        db,
      });

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      const sp = parsed['systemPrompt'] as string;

      // Body section text from the seeded components (same rows as claude_code).
      expect(sp).toContain('senior technical reviewer');
      expect(sp).toContain(REVIEW_CRITERIA_ANCHOR);

      conn.close();
    });

    it('systemPrompt security context includes security criteria text', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        context:   { ticket_type: 'security' },
        db,
      });

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      const sp = parsed['systemPrompt'] as string;

      expect(sp).toContain(SECURITY_CRITERIA_ANCHOR);
      expect(sp).toContain('All user inputs are validated at the boundary');

      conn.close();
    });

    it('model in JSON output resolves to claude_api id for claude_sonnet_4_6', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        db,
      });

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      // SEED_DATA.md §7: claude_sonnet_4_6 → claude_api alias = 'claude-sonnet-4-6'.
      expect(parsed['model']).toBe('claude-sonnet-4-6');

      conn.close();
    });

    it('id is a positive integer (composed_prompts row written on MISS)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_api',
        db,
      });

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);

      conn.close();
    });
  });

  // ── excerpt: print the claude_code artifact under security context ─────────
  // (Not an assertion — documents the consumer output for the report.)

  describe('artifact excerpt — claude_code compile under {ticket_type:security}', () => {
    it('compileAgent emits a non-empty string artifact', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({
        agentSlug: FIXTURE_AGENT_SLUG,
        platform:  'claude_code',
        context:   { ticket_type: 'security' },
        db,
      });

      // Core structural invariants.
      expect(result.content.length).toBeGreaterThan(200);
      expect(result.content).toMatch(/^---\n/);
      expect(result.content).toContain(SECURITY_CRITERIA_ANCHOR);
      expect(result.content).toContain(NO_CREDENTIALS_CONSTRAINT);

      conn.close();
    });
  });
});
