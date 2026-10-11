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

  /** Returns the first issue of a failed parse (fails the test if the parse succeeded). */
  function firstIssue(input: Record<string, unknown>): { path: PropertyKey[]; message: string } {
    const r = tasksBatchInputSchema.safeParse(input);
    if (r.success) throw new Error('expected rejection, parse succeeded');
    const issue = r.error.issues[0];
    if (!issue) throw new Error('rejection carried no issues');
    return { path: issue.path, message: issue.message };
  }

  it.each([
    ['abc', 'concurrency must be an integer or an integer string'],
    ['2.5', 'concurrency must be an integer or an integer string'],
    ['', 'concurrency must be an integer or an integer string'],
    ['0', '>0'],
    ['-1', '>0'],
    ['65', '<=64'],
  ])(
    '932604a0 R9.AC3: concurrency %j is still rejected at path [concurrency] (%s)',
    (bad, fragment) => {
      const issue = firstIssue({ ...base, concurrency: bad });
      expect(issue.path).toEqual(['concurrency']);
      expect(issue.message).toContain(fragment);
    }
  );

  it.each([
    ['not JSON', 'not json', 'prompts must be an array or a JSON-array string'],
    ['a JSON object', '{"a":1}', 'prompts must be an array or a JSON-array string'],
    ['a JSON string', '"x"', 'prompts must be an array or a JSON-array string'],
    ['an empty array', '[]', '>=1'],
    ['an array with an empty string', '["a",""]', '>=1'],
    ['an array with a non-string', '[1]', 'string'],
  ])('932604a0 R9.AC3: prompts string that is %s is still rejected at path [prompts]', (_name, bad, fragment) => {
    const issue = firstIssue({ ...base, prompts: bad });
    expect(issue.path[0]).toBe('prompts');
    expect(issue.message).toContain(fragment);
  });

  it.each([
    [' 2 ', 2],
    ['+2', 2],
    ['007', 7],
  ])('932604a0 R9.AC1: concurrency %j (padding / sign / leading zeros) is accepted as %i', (raw, expected) => {
    expect(tasksBatchInputSchema.parse({ ...base, concurrency: raw }).concurrency).toBe(expected);
  });

  it.each([
    ['-0', 'a negative zero'],
    ['1e2', 'exponent notation'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['99999999999999999999', 'a value beyond the max of 64'],
    ['\u0662', 'an Arabic-Indic digit'],
  ])('932604a0 R9.AC3: concurrency %j (%s) is rejected at path [concurrency]', (bad) => {
    const issue = firstIssue({ ...base, concurrency: bad });
    expect(issue.path).toEqual(['concurrency']);
  });

  it('932604a0 R9.AC3: the beyond-max string is rejected as too large, not as a type error', () => {
    const message = firstIssue({ ...base, concurrency: '99999999999999999999' }).message;
    expect(message).toContain('Too big');
    expect(message).not.toContain('integer string');
  });

  it('932604a0 R9.AC2: a stringified array with surrounding whitespace is accepted', () => {
    expect(
      tasksBatchInputSchema.parse({ ...base, prompts: '  [ "x" ,\n "y" ]  ' }).prompts
    ).toEqual(['x', 'y']);
  });

  it('932604a0 R9.AC3: a double-stringified array is rejected at path [prompts] with the type message', () => {
    const issue = firstIssue({ ...base, prompts: JSON.stringify(JSON.stringify(['x'])) });
    expect(issue.path).toEqual(['prompts']);
    expect(issue.message).toBe('prompts must be an array or a JSON-array string');
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

  it('932604a0 R9.AC5: advertised schema is the pre-change shape plus exactly the P2 `background` property', () => {
    // adbf1c0b (P2 background tasks_batch) legitimately added `background` to the schema and
    // moved the pin; the pre-change hash (84290017...) is recovered by dropping that one property.
    const { $schema: _drop, ...rest } = z.toJSONSchema(tasksBatchInputSchema) as Record<string, unknown> & {
      properties: Record<string, unknown>;
    };
    const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    expect(hash(rest)).toBe('937970895910b1a63d4f811f891086bd0155893ce341516f144cf856458532d2');
    const { background, ...otherProps } = rest.properties;
    expect(background).toBeDefined();
    expect(hash({ ...rest, properties: otherProps })).toBe(
      '84290017888a6cbbbb21d3cd329bc86ec14690e2d037a3a55fdc4c2ae99e2008'
    );
  });
});
