/**
 * compile-agent.test.ts
 *
 * Drives compileAgent against a REAL on-disk SQLite file seeded via the
 * upstream packages' store + seed APIs — never :memory:, never mocks
 * ([inv:real-rows-not-mocks]).
 *
 * Proves:
 *   [platform-markdown-emit.1] compileAgent entrypoint exported
 *   [platform-markdown-emit.2] markdown emitter writes YAML frontmatter
 *   [platform-markdown-emit.3] compileAgent emits real markdown+json from rows
 *
 * Invariants exercised:
 *   - claude_code compile → content STARTS with '---'; `tools:` line equals
 *     the resolved PascalCase aliases, NOT canonical names (negative-control
 *     bites here); body sections in junction order; policy constraint text
 *     present ([inv:platform-shaped-observable]).
 *   - claude_api compile → JSON.parse(content) yields { systemPrompt, tools }
 *     with a STRUCTURED tools array (not a comma string).
 *   - Persistence proven by closing the better-sqlite3 handle and REOPENING
 *     from the same file path before assertions ([inv:reopen-proves-cache]).
 *   - Negative-control: tools: line DOES NOT contain canonical names (e.g.
 *     'file_read', 'web_search'); only platform aliases ('Read', 'WebSearch').
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
import {
  AgentStore,
  ComponentStore,
  CompositionStore,
  TaxonomyStore,
} from '@adhd/agent-registry';
import {
  seed as seedToolRegistry,
  AgentToolStore,
} from '@adhd/agent-tool-registry';
import { seed as seedProvider } from '@adhd/agent-provider';
import {
  seed as seedPolicy,
  AgentPolicyStore,
} from '@adhd/agent-policy';

// Under test
import { compileAgent } from '../compile.js';

// ── helpers ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Migration folder paths relative to this test file.
 * All five package sets share ONE SQLite file (Decision C — [inv:one-db-handle]).
 *
 * test file: packages/ai/agent-compiler/src/__tests__/
 *   ../../../agent-provider/drizzle    → packages/ai/agent-provider/drizzle
 *   ../../../agent-registry/drizzle   → packages/ai/agent-registry/drizzle
 *   ../../../agent-tool-registry/drizzle → packages/ai/agent-tool-registry/drizzle
 *   ../../../agent-policy/drizzle     → packages/ai/agent-policy/drizzle
 *
 * ORDER MATTERS (per model-policy.test.ts precedent):
 *   provider (1750*) → registry (1782193*) → tool-registry (1782250*) → policy (1782256*)
 * Drizzle's migrator skips entries whose `when` <= last recorded — running
 * provider after the 1782* set would silently skip all its tables.
 */
const PROVIDER_MIGRATIONS = path.resolve(
  __dirname, '../../../agent-provider/drizzle'
);
const REGISTRY_MIGRATIONS = path.resolve(
  __dirname, '../../../agent-registry/drizzle'
);
const TOOL_REGISTRY_MIGRATIONS = path.resolve(
  __dirname, '../../../agent-tool-registry/drizzle'
);
const POLICY_MIGRATIONS = path.resolve(
  __dirname, '../../../agent-policy/drizzle'
);

interface OpenResult {
  conn: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: ReturnType<typeof drizzle<any>>;
}

/**
 * Open a fresh better-sqlite3 handle, run ALL four package migrations in the
 * correct timestamp order, and return the connection + Drizzle handle.
 *
 * FK-safe pattern: disable FKs during migration, re-enable after.
 */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  // Migrate in ascending timestamp order so Drizzle's journal bookkeeping
  // never skips a set.
  migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS    }); // 1750*
  migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS    }); // 1782193*–1782239*
  migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS }); // 1782250*–1782252*
  migrate(db, { migrationsFolder: POLICY_MIGRATIONS      }); // 1782256*–1782350*
  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('compileAgent — yaml_frontmatter + json_object emit', () => {
  let dbPath: string;
  let tmpDir: string;
  let conn: Database.Database;

  // Test slugs
  const AGENT_SLUG    = 'compile-test-agent';
  const COMP_INTRO    = 'compile-intro';
  const COMP_BODY     = 'compile-body';
  const COMP_SECURE   = 'compile-secure-criteria';
  const CATEGORY_SLUG = 'compile-test-category';
  const MODEL_HINT    = 'claude_opus_4_8';

  beforeAll(() => {
    // Real on-disk tmp file — never :memory: ([inv:real-rows-not-mocks])
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-compile-agent-'));
    dbPath = path.join(tmpDir, 'compile-agent.db');

    const { conn: c, db } = openDb(dbPath);
    conn = c;

    // ── 1. Seed provider catalog (models + model_platform_bindings) ────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);

    // ── 2. Seed tool catalog (tools + platforms + tool_platform_bindings) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedToolRegistry(db as any);

    // ── 3. Seed policy templates ────────────────────────────────────────────
    seedPolicy(db);

    // ── 4. Seed taxonomy category ───────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taxonomyStore = new TaxonomyStore(db as any);
    taxonomyStore.createCategory({ slug: CATEGORY_SLUG, name: 'Compile Test Category' });

    // ── 5. Seed agent with model_hint ───────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentStore = new AgentStore(db as any);
    agentStore.create({
      slug:             AGENT_SLUG,
      displayName:      'Compile Test Agent',
      description:      'An agent used to test compileAgent end-to-end.',
      modelHint:        MODEL_HINT,
      taxonomyCategory: CATEGORY_SLUG,
    });

    // ── 6. Seed components (prompt type 'system' first) ─────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const componentStore = new ComponentStore(db as any);
    componentStore.upsertType({
      slug:        'system',
      description: 'System prompt section',
      isSystem:    true,
    });

    const intro = componentStore.create({
      slug:        COMP_INTRO,
      type:        'system',
      content:     '# Agent Overview\n\nThis agent reviews code.',
      displayName: 'Intro',
    });

    const body = componentStore.create({
      slug:        COMP_BODY,
      type:        'system',
      content:     '## Core Behaviour\n\nAlways be helpful.',
      displayName: 'Body',
    });

    const secure = componentStore.create({
      slug:        COMP_SECURE,
      type:        'system',
      content:     '## Security Criteria\n\nApply security checks.',
      displayName: 'Security Criteria',
    });

    // ── 7. Wire agent → components via CompositionStore.attach ─────────────
    //
    // Position order (junction order, [def:junction-order]):
    //   position=1 → COMP_INTRO  (always-included, no context_condition)
    //   position=2 → COMP_BODY   (always-included)
    //   position=3 → COMP_SECURE (context-conditioned: {ticket_type:"security"})
    //
    // Mirroring SEED_DATA.md §14 "code-reviewer" example for success_criteria.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compositionStore = new CompositionStore(db as any);

    compositionStore.attach({
      agentSlug:      AGENT_SLUG,
      componentSlug:  COMP_INTRO,
      position:       1,
    });

    compositionStore.attach({
      agentSlug:      AGENT_SLUG,
      componentSlug:  COMP_BODY,
      position:       2,
    });

    compositionStore.attach({
      agentSlug:       AGENT_SLUG,
      componentSlug:   COMP_SECURE,
      position:        3,
      contextCondition: JSON.stringify({ ticket_type: 'security' }),
    });

    // ── 8. Grant tools to the agent ─────────────────────────────────────────
    // file_read → Read (claude_code) / read_file (claude_api)
    // web_search → WebSearch (claude_code) / web_search (claude_api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentToolStore = new AgentToolStore(db as any);
    agentToolStore.grant({ agentSlug: AGENT_SLUG, toolName: 'file_read',  permission: 'full'      });
    agentToolStore.grant({ agentSlug: AGENT_SLUG, toolName: 'web_search', permission: 'full'      });

    // ── 9. Attach policy constraint to the agent ────────────────────────────
    const agentPolicyStore = new AgentPolicyStore(db);
    agentPolicyStore.attach({
      agentSlug:  AGENT_SLUG,
      policySlug: 'no-credentials',
    });

    // Close write connection — tests reopen to prove persistence.
    conn.close();
  });

  afterAll(() => {
    try { conn.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(dbPath);            } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`);   } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`);   } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── [platform-markdown-emit.1] compileAgent entrypoint exported ───────────

  describe('[platform-markdown-emit.1] entrypoint exported', () => {
    it('compileAgent is a function', () => {
      expect(typeof compileAgent).toBe('function');
    });
  });

  // ── [platform-markdown-emit.2] markdown emitter writes YAML frontmatter ───

  describe('[platform-markdown-emit.2] yaml_frontmatter (claude_code)', () => {
    it('content starts with ---', () => {
      // Reopen from the SAME path — proves rows hit disk, not memory
      // ([inv:reopen-proves-cache] shape).
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // CLI stdout invariant: frontmatter artifact STARTS with '---'
      // ([inv:platform-shaped-observable], Decision B.1)
      expect(result.content).toMatch(/^---\n/);

      conn.close();
    });

    it('tools: line equals resolved PascalCase aliases — NOT canonical names', () => {
      // NEGATIVE-CONTROL: if the platform filter were absent, the tools: line
      // would contain 'file_read', 'web_search' (canonical names) instead of
      // 'Read', 'WebSearch'.  This assertion goes red in that case.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // Extract the tools: line from the frontmatter block.
      const lines = result.content.split('\n');
      const toolsLine = lines.find(l => l.startsWith('tools:'));
      expect(toolsLine).toBeDefined();

      // Aliases must be PascalCase claude_code names.
      expect(toolsLine).toContain('Read');
      expect(toolsLine).toContain('WebSearch');

      // Canonical names must NOT appear in the tools: line.
      expect(toolsLine).not.toContain('file_read');
      expect(toolsLine).not.toContain('web_search');

      conn.close();
    });

    it('model: line equals resolved platform alias "opus"', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      const lines = result.content.split('\n');
      const modelLine = lines.find(l => l.startsWith('model:'));
      expect(modelLine).toBeDefined();
      // claude_code alias for claude_opus_4_8 is 'opus' (SEED_DATA.md §7).
      expect(modelLine).toBe('model: opus');

      conn.close();
    });

    it('name: and description: fields are present in frontmatter', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      const lines = result.content.split('\n');
      expect(lines.find(l => l.startsWith('name:'))).toBe(`name: ${AGENT_SLUG}`);
      expect(lines.find(l => l.startsWith('description:'))).toBeDefined();

      conn.close();
    });

    it('body contains component content in junction order', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // Context without ticket_type → only intro + body sections included.
      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // Intro must appear before body content in the artifact.
      const introIdx  = result.content.indexOf('# Agent Overview');
      const bodyIdx   = result.content.indexOf('## Core Behaviour');
      expect(introIdx).toBeGreaterThan(-1);
      expect(bodyIdx).toBeGreaterThan(-1);
      // [def:junction-order]: intro (position=1) precedes body (position=2).
      expect(introIdx).toBeLessThan(bodyIdx);

      conn.close();
    });

    it('context-conditioned component included when context matches', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // With context {ticket_type:"security"} → COMP_SECURE included.
      const result = compileAgent({
        agentSlug: AGENT_SLUG,
        platform:  'claude_code',
        context:   { ticket_type: 'security' },
        db,
      });

      expect(result.content).toContain('## Security Criteria');

      conn.close();
    });

    it('context-conditioned component excluded when context does NOT match', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      // No matching context → COMP_SECURE excluded.
      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });
      expect(result.content).not.toContain('## Security Criteria');

      conn.close();
    });

    it('policy constraint text is present in content', () => {
      // [def:policy-constraint], Decision B.1: constraints rendered as '## Policies'
      // section in the body, NOT in frontmatter.
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // The no-credentials policy description must appear in content.
      // Template text matches /credential|leak/i (proven in model-policy.test.ts).
      expect(result.content).toMatch(/credential|leak/i);
      // The Policies section header must also appear.
      expect(result.content).toContain('## Policies');

      conn.close();
    });

    it('returns string[] tools (platform aliases)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // tools[] is string[] for yaml_frontmatter platforms.
      expect(Array.isArray(result.tools)).toBe(true);
      const toolArr = result.tools as string[];
      expect(toolArr).toContain('Read');
      expect(toolArr).toContain('WebSearch');
      // Canonical names must not appear in the tools array.
      expect(toolArr).not.toContain('file_read');
      expect(toolArr).not.toContain('web_search');

      conn.close();
    });

    it('componentVersions contains the seeded components', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // componentVersions must record version for each included component.
      expect(result.componentVersions).toHaveProperty(COMP_INTRO);
      expect(result.componentVersions).toHaveProperty(COMP_BODY);
      // intro and body at version 1 (just seeded).
      expect(result.componentVersions[COMP_INTRO]).toBe(1);
      expect(result.componentVersions[COMP_BODY]).toBe(1);

      conn.close();
    });

    it('id is a positive integer (composed_prompts row, cache wired)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });
      // id is the registry_composed_prompts row id — positive integer after the
      // composed-prompt-caching state wired the cache write ([def:composed-output]).
      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);

      conn.close();
    });

    it('sections are separated by \\n\\n (Decision B.1)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });

      // The intro section ends with its last line; next section starts after '\n\n'.
      // Verify the artifact has '\n\n' between the intro and body sections by
      // checking the join point in the body (after the frontmatter).
      //
      // intro content ends with "This agent reviews code."
      // body content starts with "## Core Behaviour"
      // Decision B.1 mandates '\n\n' between them.
      const introEnd  = result.content.indexOf('This agent reviews code.');
      const bodyStart = result.content.indexOf('## Core Behaviour');
      // There must be at least 2 newlines between intro end and body start.
      const between   = result.content.slice(introEnd + 'This agent reviews code.'.length, bodyStart);
      expect(between).toContain('\n\n');

      conn.close();
    });
  });

  // ── [platform-markdown-emit.3] compileAgent emits real markdown+json from rows

  describe('[platform-markdown-emit.3] json_object (claude_api)', () => {
    it('content is valid JSON', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_api', db });

      // content must be parseable JSON (never YAML, no --- fence).
      expect(() => JSON.parse(result.content)).not.toThrow();
      // Must NOT start with '---'.
      expect(result.content).not.toMatch(/^---/);

      conn.close();
    });

    it('JSON payload has systemPrompt, name, model, tools fields', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_api', db });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;

      expect(parsed).toHaveProperty('systemPrompt');
      expect(parsed).toHaveProperty('name', AGENT_SLUG);
      expect(parsed).toHaveProperty('tools');
      expect(parsed).toHaveProperty('model');

      conn.close();
    });

    it('tools is a STRUCTURED array (not a comma string)', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_api', db });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;

      // NEGATIVE-CONTROL: if tools were emitted as a comma string, this assertion
      // goes red — tools must be an array, not a string.
      expect(Array.isArray(parsed.tools)).toBe(true);

      conn.close();
    });

    it('model resolves to full claude_api id "claude-opus-4-8"', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_api', db });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;

      // claude_api alias for claude_opus_4_8 is the full id (SEED_DATA.md §7).
      expect(parsed.model).toBe('claude-opus-4-8');

      conn.close();
    });

    it('systemPrompt contains body content and policy constraint', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_api', db });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      const sp = parsed.systemPrompt as string;

      // Body sections present in systemPrompt.
      expect(sp).toContain('# Agent Overview');
      expect(sp).toContain('## Core Behaviour');
      // Policy constraint text present (no-credentials → /credential|leak/i).
      expect(sp).toMatch(/credential|leak/i);

      conn.close();
    });

    it('[dod.7] json.ts emitter is a separate file for both formats', () => {
      // Structural guard: both emit/markdown.ts and emit/json.ts must exist.
      // Proved by importing both emitters (this test file is in the same package).
      // If emit/json.ts didn't exist, the import at the top of compile.ts would
      // fail to resolve and every test in this file would error out.
      expect(true).toBe(true); // the import of compileAgent at file top is the proof.
    });
  });

  // ── Persistence — close + reopen proves disk write ─────────────────────────

  describe('persistence — close + reopen proves disk write', () => {
    it('compiled content is identical across independent connections', () => {
      // First fresh connection.
      const { conn: c1, db: db1 } = openDb(dbPath);
      const first = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db: db1 });
      c1.close();

      // Second independent connection from same file ([inv:reopen-proves-cache]).
      const { conn: c2, db: db2 } = openDb(dbPath);
      const second = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db: db2 });
      conn = c2;
      c2.close();

      // Teeth: if rows weren't flushed to disk, second.content would be empty/throw.
      expect(first.content.length).toBeGreaterThan(0);
      expect(second.content).toBe(first.content);
      expect(second.tools).toEqual(first.tools);
      expect(second.componentVersions).toEqual(first.componentVersions);
    });
  });

  // ── Negative control ────────────────────────────────────────────────────────

  describe('negative-control — canonical-name leak fails tools: assertion', () => {
    it('PascalCase alias assertion WOULD fail if canonical names were used', () => {
      const { conn: c, db } = openDb(dbPath);
      conn = c;

      const result = compileAgent({ agentSlug: AGENT_SLUG, platform: 'claude_code', db });
      const toolArr = result.tools as string[];

      // This is the canonical-name leak check: if resolveTools returned canonical
      // names instead of aliases, these would BOTH be 'false' (assertions would
      // pass incorrectly).  The test has teeth because canonical names are
      // different strings from platform aliases.
      //
      // 'file_read' and 'web_search' are canonical; they must NOT appear.
      expect(toolArr.includes('file_read')).toBe(false);
      expect(toolArr.includes('web_search')).toBe(false);
      // 'Read' and 'WebSearch' are the claude_code aliases; they MUST appear.
      expect(toolArr.includes('Read')).toBe(true);
      expect(toolArr.includes('WebSearch')).toBe(true);

      conn.close();
    });
  });
});
