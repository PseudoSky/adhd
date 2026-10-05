/**
 * live-harness-hermetic.spec.ts — teeth for backlog 3ba246b6 (the test-isolation
 * half: `resolveFlatLegacyDbPath()` derives the flat SOURCE from `$HOME`).
 *
 * The live dispatch e2e spawns a REAL agent-mcp whose boot runs the
 * flat→namespaced legacy migration (`migrateLegacyOperationalDb`). That
 * migration's flat source is `~/.adhd/agent-mcp/agents.db` resolved from `$HOME`,
 * and `$HOME` cannot be isolated in this suite — the `claude` CLI's OAuth
 * refresh is keychain/home-bound, so a symlinked `$HOME` breaks `claudecli`
 * (verified: "OAuth session expired"). The only safe isolation therefore is to
 * disable the migration in the spawned child's env
 * (`ADHD_AGENT_SKIP_LEGACY_MIGRATION=true`); otherwise a fresh scratch store is
 * seeded from the developer's real `~/.adhd/agent-mcp/agents.db`, polluting
 * `tasks`/`task_events` and breaking unfiltered assertions.
 *
 * This DEFAULT-RUNNING source-contract test fails if that hermetic wiring is
 * reverted. The runtime guarantee — `skipLegacyMigration` short-circuits BEFORE
 * the flat file is ever opened, while the same setup without the flag seeds —
 * is proven separately in agent-mcp's `db.legacy-migration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// src/test/ -> package root
const PKG_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const LIVE_E2E = readFileSync(
  join(PKG_ROOT, 'src', 'test', 'integration', 'live-dispatch-five-acs.e2e.test.ts'),
  'utf8'
);

describe('live dispatch e2e harness is hermetic against the developer ~/.adhd store (3ba246b6)', () => {
  it('spawns agent-mcp against an isolated scratch DB path', () => {
    expect(LIVE_E2E).toContain('ADHD_AGENT_DATABASE_PATH: dbPath');
  });

  it('disables the $HOME-derived flat→namespaced legacy migration in the child env', () => {
    expect(LIVE_E2E).toContain("ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true'");
  });

  it('strips every ambient ADHD_AGENT_* var so the real store cannot leak in via inheritance', () => {
    expect(LIVE_E2E).toContain("k.startsWith('ADHD_AGENT_')");
  });
});
