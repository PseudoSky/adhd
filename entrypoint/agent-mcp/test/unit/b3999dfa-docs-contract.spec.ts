/**
 * b3999dfa docs/config contract: documentation that states a default or a decision must agree with the code.
 *
 *   AC4  llms.txt states the same ADHD_AGENT_TOOL_RESULT_MAX_CHARS default the engine ships.
 *   AC7  the migration journal `when` values are strictly increasing (the invariant drizzle's skip rule relies
 *        on) and AGENTS.md carries the caveat.
 *   AC9  the `est_cost_usd` snake_case naming in the usage summary is a documented decision, and the summary
 *        schema accepts exactly that key.
 *
 * plan discovery-sweep-1014 blind-review A2 TEB-D1 (tier S): the stored-result bound is documented where a reader
 * looks. Failure mode: a doc keeps saying the event stores a 500-char summary, or that cap `0` stores the full
 * output, or omits the new field names, so a consumer builds on a false contract. Red run: against the docs before
 * this change the "500-char `result` summary" assertion and the "full tool output text" assertion fail and the
 * `result_stored_clipped` / `payload_clipped` / `too_large` / 16,000 assertions fail on missing text.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TOOL_RESULT_MAX_CHARS, usageSummarySchema } from '@adhd/agent-engine-orchestrator';
import { describe, expect, it } from 'vitest';

import { journalEntries } from '../fixtures/migration-journal.js';

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

describe('plan discovery-sweep-1014 blind-review A2 TEB-D1 stored result bound is documented', () => {
  const taskEventDocs = ['README.md', 'AGENTS.md'] as const;

  it.each(taskEventDocs)('plan discovery-sweep-1014 blind-review A2 TEB-D1: %s names the stored-result fields and the 16,000 bound', (doc) => {
    const text = read(doc);
    for (const name of ['result_stored_clipped', 'payload_clipped', 'too_large', '16,000']) {
      expect(text, `${doc} must mention ${name}`).toContain(name);
    }
  });

  it('plan discovery-sweep-1014 blind-review A2 TEB-D1: logging.md no longer states the 500-char result summary and documents the bound', () => {
    const logging = read('docs/logging.md');
    expect(logging).not.toContain('500-char `result` summary');
    expect(logging).toContain('16,000');
    expect(logging).toContain('result_stored_clipped');
  });

  it.each(['README.md', 'AGENTS.md', 'docs/logging.md'])('plan discovery-sweep-1014 blind-review A2 TEB-D1: %s does not say cap 0 stores the full output', (doc) => {
    const text = read(doc);
    expect(text).not.toContain('then `result` is the full tool output text');
    expect(text).not.toMatch(/stores? the full (tool )?output/i);
  });
});
