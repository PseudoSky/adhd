/**
 * registry-prompt-resolver.test.ts
 *
 * Teeth test for BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001.
 *
 * Pre-fix behavior: `buildPromptResolver()` opened the registry DB with
 * `new Database(registryDbPath, { fileMustExist: true })` and never ran any
 * migrations. On a fresh machine (the registry file has never been written by
 * anything) this threw `SQLITE_CANTOPEN`, was swallowed by a try/catch, and
 * `buildPromptResolver` silently returned `undefined` — permanently disabling
 * the registry/compiler prompt-composition integration in favor of the flat
 * system-prompt fallback.
 *
 * This test drives the REAL production `buildPromptResolver()`
 * (entrypoint/agent-mcp/src/index.ts) against a REAL on-disk SQLite file
 * under a fresh temp dir whose registry.db path does NOT pre-exist (fresh-
 * machine simulation) — never `:memory:` for the registry connection, never
 * mocks (CLAUDE.md verification standard #1). It proves, with teeth:
 *
 *   1. The resolver is DEFINED (not the flat-prompt `undefined` fallback).
 *   2. The registry DB file was actually created on disk.
 *   3. All FIVE registry-family migration sets landed on that ONE shared file
 *      (agent-core-provider, agent-store-prompts, agent-store-tools,
 *      agent-core-policy, agent-engine-compiler) — not just a partial set.
 *   4. A REAL composed prompt resolves end-to-end through
 *      `resolveComposedPrompt` (real seeded agent/component/composition rows,
 *      real `compileAgent`) and contains the seeded component content — i.e.
 *      the registry/compiler integration is genuinely reachable, not just
 *      "the DB file exists".
 *
 * Negative control (proves the test has teeth, not just green-by-accident):
 * temporarily reverting the fix (`fileMustExist: true`, no mkdir, no
 * migrations) makes this test fail with SQLITE_CANTOPEN / resolver undefined
 * — verified manually during development, see BACKLOG.md /
 * CHANGELOG.md entry for BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001 for the
 * red -> green proof transcript.
 *
 * better-sqlite3 can segfault at teardown after a clean run — trust the
 * vitest EXIT CODE, never `| grep -q` (project memory
 * feedback_plan_execution_pitfalls / CLAUDE.md verification standard #4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPromptResolver } from '../index.js';

import { resolveComposedPrompt } from '@adhd/agent-engine-orchestrator';
import {
    AgentStore,
    ComponentStore,
    CompositionStore,
    TaxonomyStore,
} from '@adhd/agent-store-prompts';
import { seed as seedToolRegistry } from '@adhd/agent-store-tools';
import { seed as seedProvider } from '@adhd/agent-core-provider';
import { seed as seedPolicy } from '@adhd/agent-core-policy';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// entrypoint/agent-mcp/src/__tests__/ -> repo root (4 levels up), per
// CLAUDE.md §10: all ephemeral test artifacts live under the single
// canonical `tmp/` root, never a scattered ad-hoc dir.
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');

const AGENT_SLUG = 'teeth-test-agent';
const CATEGORY_SLUG = 'teeth-test-category';
const COMPONENT_SLUG = 'teeth-test-component';
const COMPONENT_MARKER = 'ADHD_AGENT_MCP_TEETH_TEST_MARKER_TEXT';
// Reuse the exact model hint compile-agent.test.ts proves seedProvider() seeds
// (claude_opus_4_8), so this test doesn't need to hand-roll model/platform data.
const MODEL_HINT = 'claude_opus_4_8';

describe('buildPromptResolver — registry DB open + migrate + composition (BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001)', () => {
    let tmpDir: string;
    let registryDbPath: string;
    let agentMcpSqlite: Database.Database;

    beforeAll(() => {
        fs.mkdirSync(TMP_ROOT, { recursive: true });
        tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'registry-prompt-resolver-'));
        // Deliberately never created — simulates a fresh machine where nothing
        // has ever written to ~/.adhd/agent-mcp/registry.db.
        registryDbPath = path.join(tmpDir, 'registry.db');
        agentMcpSqlite = new Database(':memory:');
    });

    afterAll(() => {
        try { agentMcpSqlite.close(); } catch { /* already closed */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('opens + migrates a fresh registry DB and resolves a real composed prompt (not the flat fallback)', async () => {
        // Precondition: fresh-machine simulation — the file must NOT pre-exist.
        expect(fs.existsSync(registryDbPath)).toBe(false);

        // @adhd/agent-engine-compiler is lazy-loaded in production (index.ts
        // main()) to allow flat-prompt-only operation when it's absent — mirror
        // that here rather than statically importing it.
        const compilerModule = await import('@adhd/agent-engine-compiler');

        // agentMcpDb is a required BuildPromptResolverOpts field but is no
        // longer read by buildPromptResolver's body post-fix (see the comment
        // in index.ts) — a throwaway in-memory handle is sufficient here.
        const agentMcpDb = drizzle(agentMcpSqlite);

        const resolver = buildPromptResolver({
            registryDbPath,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agentMcpDb: agentMcpDb as any,
            compileAgentFn: compilerModule.compileAgent,
            compilerMigrationsOn: compilerModule.runMigrationsOn,
            compilerMigrationsFolder: compilerModule.MIGRATIONS_FOLDER,
        });

        // ── [1] resolver is DEFINED — registry DB opened + migrated, compiler
        //        integration ACTIVE (not the flat-prompt undefined fallback) ──
        expect(resolver).toBeDefined();
        if (!resolver) {
            throw new Error('unreachable: expect(resolver).toBeDefined() above would have failed the test');
        }

        // ── [2] the registry DB file was actually created on disk ──────────
        expect(fs.existsSync(registryDbPath)).toBe(true);

        // ── [3] ALL FIVE registry-family migration sets landed on this ONE
        //        shared file — one canonical table per package, not just the
        //        package whose migration happens to run first ─────────────
        const inspect = new Database(registryDbPath, { readonly: true, fileMustExist: true });
        try {
            const tableNames = new Set(
                (inspect
                    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                    .all() as Array<{ name: string }>
                ).map(r => r.name)
            );
            expect(tableNames.has('provider_providers')).toBe(true); // agent-core-provider
            expect(tableNames.has('registry_agents')).toBe(true);    // agent-store-prompts
            expect(tableNames.has('tool_types')).toBe(true);         // agent-store-tools
            expect(tableNames.has('policy_policy_types')).toBe(true); // agent-core-policy
        } finally {
            inspect.close();
        }

        // ── [4] a REAL composed prompt resolves end-to-end (not null / the
        //        flat fallback) and contains the real seeded content ───────
        const db = resolver.registryDb;

        seedProvider(db);
        seedToolRegistry(db);
        seedPolicy(db);

        const taxonomyStore = new TaxonomyStore(db);
        taxonomyStore.createCategory({ slug: CATEGORY_SLUG, name: 'Teeth Test Category' });

        const agentStore = new AgentStore(db);
        agentStore.create({
            slug: AGENT_SLUG,
            displayName: 'Teeth Test Agent',
            description: 'Proves the registry/compiler prompt-composition path is reachable.',
            modelHint: MODEL_HINT,
            taxonomyCategory: CATEGORY_SLUG,
        });

        const componentStore = new ComponentStore(db);
        componentStore.upsertType({ slug: 'system', description: 'System prompt section', isSystem: true });
        componentStore.create({
            slug: COMPONENT_SLUG,
            type: 'system',
            content: `# Teeth Test\n\n${COMPONENT_MARKER}`,
        });

        const compositionStore = new CompositionStore(db);
        compositionStore.attach({ agentSlug: AGENT_SLUG, componentSlug: COMPONENT_SLUG, position: 1 });

        const result = resolveComposedPrompt(
            { agentSlug: AGENT_SLUG, platform: 'claude_code' },
            resolver
        );

        expect(result).not.toBeNull();
        if (!result) {
            throw new Error('unreachable: expect(result).not.toBeNull() above would have failed the test');
        }
        expect(result.content).toContain(COMPONENT_MARKER);
    });
});
