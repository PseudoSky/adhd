/**
 * tasks_batch input tolerance (backlog 932604a0 / plan f52586fc R9).
 *
 * A model may send `concurrency` as a base-10 integer string and `prompts` as
 * a stringified JSON array. The schema accepts those shapes and keeps rejecting
 * genuinely invalid input. Pure schema tests: no process, no network.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tasksBatchInputSchema } from '../validation/task.js';

const base = { agent_name: 'a', prompts: ['p1', 'p2'] };

describe('932604a0 R9 AC1-AC5 tasks_batch string-typed arguments', () => {
  it('932604a0 R9.AC1: concurrency "2" parses to 2; native number and absence unchanged', () => {
    expect(tasksBatchInputSchema.parse({ ...base, concurrency: '2' }).concurrency).toBe(2);
    expect(tasksBatchInputSchema.parse({ ...base, concurrency: 2 }).concurrency).toBe(2);
    expect(tasksBatchInputSchema.parse(base).concurrency).toBeUndefined();
  });

  it('932604a0 R9.AC2: prompts as a JSON string decodes to the array; native array unchanged', () => {
    expect(
      tasksBatchInputSchema.parse({ ...base, prompts: JSON.stringify(['x', 'y']) }).prompts
    ).toEqual(['x', 'y']);
    expect(tasksBatchInputSchema.parse(base).prompts).toEqual(['p1', 'p2']);
  });

  it.each(['abc', '2.5', '0', '-1', '65', ''])(
    '932604a0 R9.AC3: concurrency %j is still rejected',
    (bad) => {
      expect(tasksBatchInputSchema.safeParse({ ...base, concurrency: bad }).success).toBe(false);
    }
  );

  it.each([
    ['not JSON', 'not json'],
    ['a JSON object', '{"a":1}'],
    ['a JSON string', '"x"'],
    ['an empty array', '[]'],
    ['an array with an empty string', '["a",""]'],
    ['an array with a non-string', '[1]'],
  ])('932604a0 R9.AC3: prompts string that is %s is still rejected', (_name, bad) => {
    expect(tasksBatchInputSchema.safeParse({ ...base, prompts: bad }).success).toBe(false);
  });

  it('932604a0 R9.AC3: native invalid values are still rejected', () => {
    expect(tasksBatchInputSchema.safeParse({ ...base, concurrency: 0 }).success).toBe(false);
    expect(tasksBatchInputSchema.safeParse({ ...base, concurrency: 2.5 }).success).toBe(false);
    expect(tasksBatchInputSchema.safeParse({ ...base, prompts: [] }).success).toBe(false);
  });

  it('932604a0 R9.AC4: the exact R4 C1 shape parses to concurrency 2 and the decoded array', () => {
    const out = tasksBatchInputSchema.parse({
      agent_name: 'worker',
      concurrency: '2',
      prompts: '["first task","second task","third task"]',
    });
    expect(out.concurrency).toBe(2);
    expect(out.prompts).toEqual(['first task', 'second task', 'third task']);
  });

  it('932604a0 R9.AC5: advertised JSON schema (z.toJSONSchema, as server toMcpInputSchema derives it) still types concurrency integer and prompts array', () => {
    const js = z.toJSONSchema(tasksBatchInputSchema) as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(js.properties['concurrency']?.type).toBe('integer');
    expect(js.properties['prompts']?.type).toBe('array');
    expect(js.required ?? []).not.toContain('concurrency');
    expect(js.required ?? []).toContain('prompts');
  });

  it('932604a0 R9.AC5: advertised schema is byte-identical to the pre-change shape (same pin as 0d0004b8 R3-PAR-C, over the MCP-stripped form)', () => {
    const { $schema: _drop, ...rest } = z.toJSONSchema(tasksBatchInputSchema) as Record<string, unknown>;
    const sha = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    expect(sha).toBe('84290017888a6cbbbb21d3cd329bc86ec14690e2d037a3a55fdc4c2ae99e2008');
  });
});
