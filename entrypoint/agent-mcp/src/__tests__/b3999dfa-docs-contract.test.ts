/**
 * b3999dfa docs/config contract: documentation that states a default or a decision must agree with the code.
 *
 *   AC4  llms.txt states the same ADHD_AGENT_TOOL_RESULT_MAX_CHARS default the engine ships.
 *   AC7  the migration journal `when` values are strictly increasing (the invariant drizzle's skip rule relies
 *        on) and AGENTS.md carries the caveat.
 *   AC9  the `est_cost_usd` snake_case naming in the usage summary is a documented decision, and the summary
 *        schema accepts exactly that key.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TOOL_RESULT_MAX_CHARS, usageSummarySchema } from '@adhd/agent-engine-orchestrator';
import { describe, expect, it } from 'vitest';

import { journalEntries } from './fixtures/migration-journal.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(pkgRoot, rel), 'utf8');

describe('b3999dfa docs contract', () => {
  it('b3999dfa AC4: llms.txt states the shipped ADHD_AGENT_TOOL_RESULT_MAX_CHARS default', () => {
    const line = read('llms.txt')
      .split('\n')
      .find((l) => l.includes('`ADHD_AGENT_TOOL_RESULT_MAX_CHARS`'));
    expect(line, 'llms.txt must document ADHD_AGENT_TOOL_RESULT_MAX_CHARS').toBeDefined();
    expect(line).toContain(`default: ${DEFAULT_TOOL_RESULT_MAX_CHARS};`);
  });

  it('b3999dfa AC7: journal `when` is strictly increasing, and AGENTS.md documents drizzle\'s skip rule', () => {
    const whens = journalEntries().map((e) => e.when);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i], `entry ${i} must be stamped after entry ${i - 1}`).toBeGreaterThan(whens[i - 1]);
    }
    const agents = read('AGENTS.md');
    expect(agents).toContain('Journal `when` caveat');
    expect(agents).toContain('silently SKIPPED');
  });

  it('b3999dfa AC9: est_cost_usd stays snake_case in the usage summary, as documented', () => {
    const summary = {
      inputTokens: 1, outputTokens: 1, modelCalls: 1, toolCallCount: 0, latencyMs: 0,
      uncachedInputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, peakContextTokens: 1,
    };
    expect(usageSummarySchema.safeParse({ ...summary, est_cost_usd: 0.5 }).success).toBe(true);
    expect(usageSummarySchema.safeParse({ ...summary, estCostUsd: 0.5 }).success).toBe(false);
    expect(read('docs/logging.md')).toContain('snake_case beside the camelCase token counters');
  });
});
