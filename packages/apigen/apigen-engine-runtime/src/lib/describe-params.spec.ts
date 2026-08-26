import { describe, expect, it } from 'vitest';
import { describeParams } from './describe-params';

/**
 * P5-cli-serve-transport — "backlog CLI: --help shows only `{ input: object
 * }` (all six verbs)". `describeParams` is the single source both
 * `apigen-plugin-cli-output`'s per-command `--help` text (`paramsText`) and
 * `apigen-plugin-mcp`'s tool description log line render from — see
 * op-plan.ts's `buildOpPlan`, which calls this and stores the result
 * verbatim on `OpPlan.params`. Proving THIS expands nested object params one
 * level deep proves both transports' `--help` output does too, without
 * needing to spawn either plugin's real CLI/MCP surface.
 */
describe('describeParams — top-level object params expand one level (never a bare "object" placebo)', () => {
  it('a single object-typed param (e.g. update\'s `input`) renders its own fields, including `repo`', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                type: 'object',
                required: ['repo', 'humanId', 'by'],
                properties: {
                  repo: { type: 'string' },
                  humanId: { type: 'string' },
                  patch: { type: 'object', properties: { title: { type: 'string' } } },
                  by: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };

    const { params, text } = describeParams(schema);

    expect(params).toEqual([
      {
        name: 'input',
        required: true,
        // Nested one level: repo/humanId/by are named explicitly; `patch`
        // (a doubly-nested object) collapses to the plain `object`
        // placeholder — expansion is bounded to exactly one level.
        type: '{ repo: string, humanId: string, patch?: object, by: string }',
      },
    ]);
    expect(text).toBe('input: { repo: string, humanId: string, patch?: object, by: string }');
    // The regression this test guards: field-level detail (specifically
    // `repo`, called out by name in the finding) must be visible, never
    // collapsed to the placebo `object`.
    expect(text).toContain('repo: string');
    expect(text).not.toBe('input: object');
  });

  it('an object param with no declared properties still falls back to the plain "object" placeholder', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['input'],
            properties: { input: { type: 'object' } },
          },
        },
      },
    };
    expect(describeParams(schema).text).toBe('input: object');
  });

  it('a primitive top-level param is unaffected (array/enum/union/scalar rendering unchanged)', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['count'],
            properties: {
              count: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
              mode: { enum: ['a', 'b'] },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('count: number, tags?: string[], mode?: enum');
  });
});
