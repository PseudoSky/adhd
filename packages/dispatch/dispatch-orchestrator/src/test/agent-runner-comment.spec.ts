/**
 * Test-per-AC for backlog b922ff86: the `agent-runner.ts` comment must cite
 * the CANONICAL namespaced operational store, never the legacy flat path.
 *
 * The "docs/comment-only" item is proven by reading the source file and
 * asserting its content — these assertions fail if the fix is reverted to the
 * legacy `~/.adhd/agent-mcp/agents.db` citation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../lib/agent-runner.ts', import.meta.url)),
  'utf8'
);

describe('agent-runner.ts store-path comment (b922ff86)', () => {
  it('AC1: cites the canonical namespaced operational store path', () => {
    expect(source).toContain('.adhd/agent-mcp/production/data/agents.db');
  });

  it('AC2: does NOT cite the legacy flat agents.db path', () => {
    expect(source).not.toContain('~/.adhd/agent-mcp/agents.db');
  });
});
