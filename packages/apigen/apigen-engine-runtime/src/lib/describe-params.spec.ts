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

  it('a primitive top-level param is unaffected (array/scalar rendering unchanged)', () => {
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
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('count: number, tags?: string[]');
  });
});

/**
 * BUG-BACKLOG-CLI-HELP-BARE-ENUM-001 / BUG-BACKLOG-CLI-HELP-BARE-UNION-001 —
 * `query --help` rendered `view?: enum` (no way to discover the actual
 * allowed values, e.g. `'projects'`/`'components'`/`'locations'`) and `get
 * --help` rendered its whole mounted input as the contentless `{ input: union
 * }` (no way to discover either of its two structurally-disjoint variants).
 * `describeParams` is the single source both `apigen-plugin-cli-output`'s
 * per-command `--help` (`paramsText`) and `apigen-plugin-mcp`'s tool
 * description render from (see this file's other describe block's own doc
 * comment) — proving it here proves both transports without spawning either.
 */
describe('describeParams — enum values and union members render in full, never the bare placeholder word', () => {
  it('an enum-typed param renders its actual allowed values, not the bare word "enum"', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: [],
            properties: {
              view: { enum: ['list', 'similar', 'projects', 'components', 'locations'] },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe(
      "view?: 'list'|'similar'|'projects'|'components'|'locations'"
    );
    expect(text).not.toContain(': enum');
  });

  it('an enum nested inside an array item ALSO renders in full (enum expansion is unconditional, not gated by the one-level object/union bound)', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: [],
            properties: {
              fields: { type: 'array', items: { enum: ['uid', 'title'] } },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe("fields?: 'uid'|'title'[]");
  });

  it('a top-level (mounted) discriminated-union param expands its member shapes, not the bare word "union"', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['uid'],
                    properties: {
                      uid: { type: 'string' },
                      fields: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  {
                    type: 'object',
                    required: ['registry', 'name'],
                    properties: {
                      registry: { enum: ['project', 'component', 'location'] },
                      name: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe(
      "input: { uid: string, fields?: string[] } | { registry: 'project'|'component'|'location', name: string }"
    );
    expect(text).not.toBe('input: union');
    expect(text).not.toContain(': union');
  });

  it('a union NESTED inside an already-expanded object field stays the bare "union" placeholder (one-level expansion bound preserved)', () => {
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
                required: ['id'],
                properties: {
                  id: { type: 'string' },
                  ref: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                },
              },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('input: { id: string, ref?: union }');
  });

  it('a union whose member is itself a union truncates the inner union to "union" instead of re-expanding it (S-19 depth budget)', () => {
    // The old boolean `expand` was threaded through `unionValues` unchanged,
    // so a `oneOf` member that is directly another `oneOf`/`anyOf` (no
    // intervening object) re-expanded at every nesting level. With the integer
    // depth budget, the top-level union expands at depth 2 → members at depth
    // 1; the inner union (depth 1 < 2) collapses to the `union` placeholder,
    // while the scalar `boolean` member still shows.
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                oneOf: [
                  { oneOf: [{ type: 'string' }, { type: 'number' }] },
                  { type: 'boolean' },
                ],
              },
            },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('input: union | boolean');
    // Pre-fix this rendered 'input: string | number | boolean' — the inner
    // union was fully re-expanded. Pin the absence of the runaway expansion.
    expect(text).not.toContain('string | number');
  });

  it('a deeply-nested union terminates at the depth budget (bounded recursion, no stack overflow)', () => {
    // Directly exercises S-19's "unbounded recursion": a 50k-deep union chain.
    // The old boolean `expand` recursed once per level (RangeError: Maximum
    // call stack size exceeded); the integer budget stops at the first nested
    // union. Building the chain is cheap; only the render is under test.
    let inner: unknown = { type: 'string' };
    for (let i = 0; i < 50_000; i++) {
      inner = { oneOf: [inner, { type: 'number' }] };
    }
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: ['input'],
            properties: { input: inner },
          },
        },
      },
    };
    expect(() => describeParams(schema)).not.toThrow();
    // Top union expands; its first member (the next union down) truncates.
    expect(describeParams(schema).text).toBe('input: union | number');
  });

  it('an empty enum array renders a placeholder, never a bare trailing colon (C-21)', () => {
    // `def.enum` is truthy for `[]`, so the enum branch fired and
    // `[].map(...).join('|')` produced '' — rendering `mode?: ` with nothing
    // after the colon.
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: [],
            properties: { mode: { enum: [] } },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('mode?: unknown');
    expect(text).not.toBe('mode?: ');
    expect(text).not.toMatch(/:\s*$/);
  });

  it('an empty union array (anyOf/oneOf: []) renders a placeholder, never a bare trailing colon (C-21)', () => {
    // `def.anyOf` is truthy for `[]`, so the union branch fired and
    // `[].map(...).join(' | ')` produced '' — rendering `mode?: ` with nothing
    // after the colon. Mirrors the empty-enum guard.
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            required: [],
            properties: { mode: { oneOf: [] }, other: { anyOf: [] } },
          },
        },
      },
    };
    const { text } = describeParams(schema);
    expect(text).toBe('mode?: unknown, other?: unknown');
    expect(text).not.toMatch(/:\s*(,|$)/);
  });
});
