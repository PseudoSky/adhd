/**
 * compile-cli.test.ts
 *
 * Behavioral test for the compile CLI bin ([dod.5], [compile-cli.1],
 * [compile-cli.2]).
 *
 * Drives the REAL built bin as a child process against a REAL seeded
 * on-disk SQLite file — never in-process, never mocks
 * ([inv:real-rows-not-mocks], CLAUDE.md verification standard #1).
 *
 * Proves:
 *   [compile-cli.1] CLI parses --platform/--context/--out-dir/--all
 *   [compile-cli.2] CLI drives compile and asserts stdout markdown
 *
 * Invariants exercised:
 *   - compile <slug> --platform claude_code → EXIT 0, stdout begins with '---',
 *     contains resolved 'tools:' line  ([inv:platform-shaped-observable]).
 *   - compile <slug> --platform claude_api → EXIT 0, stdout is valid JSON with
 *     'systemPrompt' + 'tools' ([def:composed-output]).
 *   - compile <slug> --format json → EXIT 0, JSON.parse succeeds, has
 *     'systemPrompt' key.
 *   - compile <slug> --out-dir <d> → EXIT 0, file written to <d>/<slug>.md.
 *   - compile --all --category <c> --out-dir <d> → EXIT 0, all category agents
 *     written.
 *   - unknown slug → EXIT NON-ZERO, stderr has 'not found' (negative control).
 *
 * Gate on the child's EXIT CODE — never on `| grep -q` (CLAUDE.md standard #4).
 *
 * better-sqlite3 can segfault at teardown after a clean run — trust the
 * vitest exit code, not just stdout (project memory feedback_plan_execution_pitfalls).
 *
 * Module resolution for the spawned bin:
 *   The compiled bin lives in dist/ and imports '@adhd/*' packages.  Node ESM
 *   resolution walks up from the bin's directory looking for node_modules/.
 *   beforeAll creates symlinks under dist/packages/ai/agent-compiler/node_modules/@adhd/
 *   → the corresponding dist packages so normal resolution finds them.
 *   afterAll removes those symlinks.
 */

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
import { seed as seedProvider }               from '@adhd/agent-provider';
import { seed as seedPolicy, AgentPolicyStore } from '@adhd/agent-policy';

// ── constants ─────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Migration folders relative to this test file (same pattern as
 * compile-agent.test.ts — ascending timestamp order).
 *
 * test file: packages/ai/agent-compiler/src/__tests__/
 *   ../../.. = packages/ai/
 */
const AI_SRC = path.resolve(__dirname, '../../../');

const PROVIDER_MIGRATIONS      = path.join(AI_SRC, 'agent-provider/drizzle');
const REGISTRY_MIGRATIONS      = path.join(AI_SRC, 'agent-registry/drizzle');
const TOOL_REGISTRY_MIGRATIONS = path.join(AI_SRC, 'agent-tool-registry/drizzle');
const POLICY_MIGRATIONS        = path.join(AI_SRC, 'agent-policy/drizzle');

/**
 * Layout:
 *   REPO_ROOT      = adhd-agent-registry/
 *   AI_DIST        = dist/packages/ai/
 *   COMPILER_DIST  = dist/packages/ai/agent-compiler/
 *   BIN            = dist/packages/ai/agent-compiler/src/cli/compile.js
 *
 * Relative to packages/ai/agent-compiler/src/__tests__/:
 *   ../../../../../  = repo root (5 levels up)
 */
const REPO_ROOT      = path.resolve(__dirname, '../../../../../');
const AI_DIST        = path.join(REPO_ROOT, 'dist/packages/ai');
const COMPILER_DIST  = path.join(AI_DIST, 'agent-compiler');
const BIN            = path.join(COMPILER_DIST, 'src/cli/compile.js');

/**
 * @adhd packages that the CLI bin imports at runtime.
 * We symlink these into COMPILER_DIST/node_modules/@adhd/ so Node's ESM
 * resolution finds them when executing the bin from dist/.
 */
const ADHD_DIST_DEPS: Record<string, string> = {
  'agent-registry':      path.join(AI_DIST, 'agent-registry'),
  'agent-tool-registry': path.join(AI_DIST, 'agent-tool-registry'),
  'agent-provider':      path.join(AI_DIST, 'agent-provider'),
  'agent-policy':        path.join(AI_DIST, 'agent-policy'),
  'agent-mcp-types':     path.join(AI_DIST, 'agent-mcp-types'),
};

/** Path where we write @adhd symlinks for the spawned bin's resolution. */
const ADHD_NM_DIR = path.join(COMPILER_DIST, 'node_modules', '@adhd');

// ── DB helper ─────────────────────────────────────────────────────────────

interface OpenResult {
  conn: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: ReturnType<typeof drizzle<any>>;
}

/**
 * Open a fresh better-sqlite3 handle, run all four upstream migrations in
 * ascending timestamp order, and return the connection + Drizzle handle.
 * FK-safe: disable FKs during migration, re-enable after.
 */
function openDb(dbPath: string): OpenResult {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });
  migrate(db, { migrationsFolder: PROVIDER_MIGRATIONS });
  migrate(db, { migrationsFolder: REGISTRY_MIGRATIONS });
  migrate(db, { migrationsFolder: TOOL_REGISTRY_MIGRATIONS });
  migrate(db, { migrationsFolder: POLICY_MIGRATIONS });
  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ── spawn helper ──────────────────────────────────────────────────────────

/**
 * Spawn the built CLI bin as a child process, keying on its EXIT CODE.
 * Returns { status, stdout, stderr } — never throws.
 */
function spawnBin(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout:  30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── suite ─────────────────────────────────────────────────────────────────

describe('compile CLI bin — child-process behavioral tests', () => {
  let dbPath:  string;
  let tmpDir:  string;
  let conn:    Database.Database;

  // Test slugs and constants
  const AGENT_SLUG    = 'cli-test-agent';
  const COMP_INTRO    = 'cli-intro';
  const COMP_BODY     = 'cli-body';
  const CATEGORY_SLUG = 'cli-test-category';
  const MODEL_HINT    = 'claude_opus_4_8';

  // ── beforeAll: build the package, wire symlinks, seed a real DB ───────

  beforeAll(() => {
    // ── 1. Build the package so the CLI bin exists at BIN ─────────────────
    // The build runs nx tsc which emits to dist/.  nx cache makes reruns fast.
    const build = spawnSync(
      'npx',
      ['--yes', 'nx', 'build', 'agent-compiler'],
      {
        encoding: 'utf8',
        cwd:      REPO_ROOT,
        timeout:  120_000,
        shell:    true,
      }
    );
    if (build.status !== 0) {
      throw new Error(
        `nx build agent-compiler failed (exit ${build.status ?? '?'}):\n` +
        `stdout: ${build.stdout}\nstderr: ${build.stderr}`
      );
    }
    if (!fs.existsSync(BIN)) {
      throw new Error(`Built bin not found at: ${BIN}`);
    }

    // ── 2. Create @adhd symlinks so the bin resolves its ESM imports ──────
    //
    // Node ESM resolution walks up from the bin's path looking for
    // node_modules/@adhd/<pkg>.  We create symlinks pointing each @adhd dep
    // to its dist counterpart.  This mirrors the environment a published
    // package would have (where npm installs the real packages into
    // node_modules/).  The symlinks are removed in afterAll.
    fs.mkdirSync(ADHD_NM_DIR, { recursive: true });
    for (const [name, target] of Object.entries(ADHD_DIST_DEPS)) {
      const linkPath = path.join(ADHD_NM_DIR, name);
      if (fs.existsSync(target)) {
        try {
          // Remove stale symlink/dir if present from a previous run.
          fs.rmSync(linkPath, { recursive: true, force: true });
          fs.symlinkSync(target, linkPath, 'dir');
        } catch {
          // Non-fatal: if symlink fails (e.g., already exists and identical),
          // the resolution will still work.
        }
      }
    }

    // ── 3. Create a real on-disk DB — never :memory: ─────────────────────
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-cli-'));
    dbPath = path.join(tmpDir, 'cli-test.db');

    const { conn: c, db } = openDb(dbPath);
    conn = c;

    // ── 4. Seed upstream catalogs ────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedProvider(db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedToolRegistry(db as any);
    seedPolicy(db);

    // ── 5. Seed taxonomy category ────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taxonomyStore = new TaxonomyStore(db as any);
    taxonomyStore.createCategory({ slug: CATEGORY_SLUG, name: 'CLI Test Category' });

    // ── 6. Seed agent ────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentStore = new AgentStore(db as any);
    agentStore.create({
      slug:             AGENT_SLUG,
      displayName:      'CLI Test Agent',
      description:      'An agent used to test the compile CLI bin.',
      modelHint:        MODEL_HINT,
      taxonomyCategory: CATEGORY_SLUG,
    });

    // ── 7. Seed components ────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const componentStore = new ComponentStore(db as any);
    componentStore.upsertType({ slug: 'system', description: 'System section', isSystem: true });

    componentStore.create({
      slug:    COMP_INTRO,
      type:    'system',
      content: '# CLI Agent\n\nYou are a CLI test agent.',
    });

    componentStore.create({
      slug:    COMP_BODY,
      type:    'system',
      content: '## Instructions\n\nAlways respond clearly.',
    });

    // ── 8. Wire agent → components ────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compositionStore = new CompositionStore(db as any);
    compositionStore.attach({ agentSlug: AGENT_SLUG, componentSlug: COMP_INTRO, position: 1 });
    compositionStore.attach({ agentSlug: AGENT_SLUG, componentSlug: COMP_BODY,  position: 2 });

    // ── 9. Grant tools ────────────────────────────────────────────────────
    // file_read → Read (claude_code), web_search → WebSearch (claude_code)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentToolStore = new AgentToolStore(db as any);
    agentToolStore.grant({ agentSlug: AGENT_SLUG, toolName: 'file_read',  permission: 'full' });
    agentToolStore.grant({ agentSlug: AGENT_SLUG, toolName: 'web_search', permission: 'full' });

    // ── 10. Attach policy ─────────────────────────────────────────────────
    const agentPolicyStore = new AgentPolicyStore(db);
    agentPolicyStore.attach({ agentSlug: AGENT_SLUG, policySlug: 'no-credentials' });

    // Close write connection — bin spawns its own handle.
    conn.close();
  }, 180_000); // generous timeout for the nx build

  afterAll(() => {
    try { conn.close(); }  catch { /* already closed */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Remove @adhd symlinks created in beforeAll.
    try { fs.rmSync(ADHD_NM_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── [compile-cli.1] CLI parses --platform/--context/--out-dir/--all ───

  describe('[compile-cli.1] flag parsing and dispatch', () => {
    it('compile <slug> --platform claude_code --db <tmp> → EXIT 0, stdout begins with ---', () => {
      // [inv:platform-shaped-observable]: frontmatter starts with '---'.
      // This is the primary behavioral gate — a real child process, exit code.
      const { status, stdout, stderr } = spawnBin([
        'compile', AGENT_SLUG,
        '--platform', 'claude_code',
        '--db', dbPath,
      ]);

      expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);
      expect(stdout).toMatch(/^---\n/);
    });

    it('stdout contains a resolved tools: line with platform aliases', () => {
      const { status, stdout, stderr } = spawnBin([
        'compile', AGENT_SLUG,
        '--platform', 'claude_code',
        '--db', dbPath,
      ]);

      expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);

      // Frontmatter must contain a tools: line.
      const toolsLine = stdout.split('\n').find(l => l.startsWith('tools:'));
      expect(toolsLine, 'tools: line missing from stdout').toBeDefined();

      // Resolved PascalCase aliases (not canonical names).
      expect(toolsLine).toContain('Read');
      expect(toolsLine).toContain('WebSearch');
      // Canonical names must NOT leak into the tools: line.
      expect(toolsLine).not.toContain('file_read');
      expect(toolsLine).not.toContain('web_search');
    });

    it('--out-dir <d> writes <slug>.md file instead of printing to stdout', () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-'));
      try {
        const { status, stdout, stderr } = spawnBin([
          'compile', AGENT_SLUG,
          '--platform', 'claude_code',
          '--db', dbPath,
          '--out-dir', outDir,
        ]);

        expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);
        // Nothing printed to stdout when --out-dir is set.
        expect(stdout).toBe('');

        const outFile = path.join(outDir, `${AGENT_SLUG}.md`);
        expect(fs.existsSync(outFile), `output file not found: ${outFile}`).toBe(true);
        const written = fs.readFileSync(outFile, 'utf8');
        expect(written).toMatch(/^---\n/);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it('--all --category <c> --out-dir <d> compiles all agents in category', () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-all-out-'));
      try {
        const { status, stderr } = spawnBin([
          'compile',
          '--all',
          '--category', CATEGORY_SLUG,
          '--platform', 'claude_code',
          '--db', dbPath,
          '--out-dir', outDir,
        ]);

        expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);

        // The seeded category has one agent (AGENT_SLUG).
        const outFile = path.join(outDir, `${AGENT_SLUG}.md`);
        expect(fs.existsSync(outFile), `output file not found: ${outFile}`).toBe(true);
        const written = fs.readFileSync(outFile, 'utf8');
        expect(written).toMatch(/^---\n/);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  // ── [compile-cli.2] CLI drives compile and asserts stdout markdown ─────

  describe('[compile-cli.2] stdout content + JSON format', () => {
    it('stdout contains body content in junction order', () => {
      const { status, stdout, stderr } = spawnBin([
        'compile', AGENT_SLUG,
        '--platform', 'claude_code',
        '--db', dbPath,
      ]);

      expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);

      // Both body sections must appear in junction order.
      const introIdx = stdout.indexOf('# CLI Agent');
      const bodyIdx  = stdout.indexOf('## Instructions');
      expect(introIdx).toBeGreaterThan(-1);
      expect(bodyIdx).toBeGreaterThan(-1);
      // [def:junction-order]: position=1 precedes position=2.
      expect(introIdx).toBeLessThan(bodyIdx);
    });

    it('--platform claude_api → EXIT 0, stdout is valid JSON with systemPrompt + tools', () => {
      // [def:composed-output]: json_object emit for claude_api.
      const { status, stdout, stderr } = spawnBin([
        'compile', AGENT_SLUG,
        '--platform', 'claude_api',
        '--db', dbPath,
      ]);

      expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);

      let parsed: Record<string, unknown>;
      expect(() => { parsed = JSON.parse(stdout); }, 'stdout must be valid JSON').not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(parsed!).toHaveProperty('systemPrompt');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(parsed!).toHaveProperty('tools');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(Array.isArray(parsed!['tools']), 'tools must be an array').toBe(true);
    });

    it('--format json → EXIT 0, JSON.parse succeeds, has systemPrompt key', () => {
      // --format json wraps any platform's output in a JSON envelope.
      const { status, stdout, stderr } = spawnBin([
        'compile', AGENT_SLUG,
        '--platform', 'claude_code',
        '--format', 'json',
        '--db', dbPath,
      ]);

      expect(status, `EXIT CODE (stderr: ${stderr})`).toBe(0);

      let parsed: Record<string, unknown>;
      expect(() => { parsed = JSON.parse(stdout); }, 'stdout must be valid JSON').not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(parsed!).toHaveProperty('systemPrompt');
    });
  });

  // ── negative control — unknown slug exits non-zero ─────────────────────

  describe('negative control — unknown slug exits non-zero', () => {
    it('unknown slug → EXIT NON-ZERO with "not found" on stderr (MUST fail with wrong code)', () => {
      // NEGATIVE CONTROL WITH TEETH: if the bin ignored unknown slugs and
      // exited 0, this assertion would fail (status would be 0, not > 0).
      const { status, stderr } = spawnBin([
        'compile', 'slug-that-does-not-exist-xyz',
        '--platform', 'claude_code',
        '--db', dbPath,
      ]);

      // Key on EXIT CODE — not on grep.
      expect(status, 'unknown slug must exit non-zero').not.toBe(0);
      // Stderr must carry a meaningful error message.
      expect(stderr.toLowerCase()).toMatch(/not found|error/);
    });
  });
});
