// @adhd/apigen-plugin-ts-types — emitter unit tests (SPEC §Test plan A).
//
// Covers all 11 cases: primitives, object+required, arrays, enums, $ref,
// discriminated union (hand-built `_batch` shape — the authoritative union
// proof), sanitizeIdentifier load-bearing, rejections, the pkg.schemas
// fallback with data-wrapper unwrap, the plugin object contract, and the
// esbuild compile check with a negative control (bare `-` identifier splice
// must make esbuild reject the file).

import { describe, it, expect } from 'vitest';
import { transform } from 'esbuild';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, PluginInput } from '@adhd/apigen-core-client';
import { tsTypesPlugin } from '../lib/plugin';
import {
  emitFnTypes,
  typeName,
  pkgPrefixFor,
  unwrapDataWrapper,
} from '../lib/emit-types';

// ---------------------------------------------------------------------------
// Helpers — build PluginInput the way the real CLI does (operations populated)
// ---------------------------------------------------------------------------

function op(name: string, input: unknown, output: unknown): Operation {
  return {
    id: `demo-api/${name}`,
    host: 'ts',
    namespace: { raw: 'demo-api', words: ['demo', 'api'] },
    path: [
      { raw: 'demo-api', words: ['demo', 'api'] },
      { raw: name, words: tokenize(name) },
    ],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: input as Operation['input'],
    output: output as Operation['output'],
    envelope: {},
    typeText: null,
  };
}

function opsInput(
  pkgId: string,
  fns: Array<[string, unknown, unknown]>
): PluginInput {
  return {
    packages: [{ id: pkgId, schemas: {}, importPath: pkgId }],
    outputDir: '.',
    options: {},
    // `operations` is a top-level PluginInput field (real CLI shape —
    // orchestrateGenerate threads the merged descriptor through it).
    operations: fns.map(([name, input, output]) => op(name, input, output)),
  };
}

/** Generate via the real plugin for a 1-fn input; returns the emitted file content. */
function emit(pkgId: string, fnName: string, input: unknown, output: unknown): string {
  const out = tsTypesPlugin.generate(opsInput(pkgId, [[fnName, input, output]]));
  expect(out.files).toHaveLength(1);
  return out.files[0].content;
}

const STRING = { type: 'string' };

// ---------------------------------------------------------------------------
// 1. Primitives
// ---------------------------------------------------------------------------

describe('primitives', () => {
  it('maps string/number/integer/boolean/null to their TS spellings', () => {
    const content = emit(
      'demo-api',
      'echo',
      {
        type: 'object',
        properties: {
          s: STRING,
          n: { type: 'number' },
          i: { type: 'integer' },
          b: { type: 'boolean' },
          z: { type: 'null' },
        },
        required: ['s', 'n', 'i', 'b', 'z'],
      },
      STRING
    );
    expect(content).toContain('s: string;');
    expect(content).toContain('n: number;');
    expect(content).toContain('i: number;');
    expect(content).toContain('b: boolean;');
    expect(content).toContain('z: null;');
    expect(content).toContain('export type DemoApiEchoOutput = string;');
  });
});

// ---------------------------------------------------------------------------
// 2. Object + required
// ---------------------------------------------------------------------------

describe('objects and required', () => {
  it('emits named interfaces: required members plain, others optional', () => {
    const content = emit(
      'demo-api',
      'getUser',
      {
        type: 'object',
        properties: { userId: STRING, name: STRING },
        required: ['userId'],
      },
      {
        type: 'object',
        properties: { id: STRING },
        required: ['id'],
      }
    );
    expect(content).toContain('export interface DemoApiGetUserInput {');
    expect(content).toContain('userId: string;');
    expect(content).toContain('name?: string;');
    expect(content).toContain('export interface DemoApiGetUserOutput {');
    expect(content).toContain('id: string;');
  });
});

// ---------------------------------------------------------------------------
// 3. Arrays
// ---------------------------------------------------------------------------

describe('arrays', () => {
  it('emits string[] and named element interfaces for arrays of objects', () => {
    const content = emit(
      'demo-api',
      'createUsers',
      {
        type: 'object',
        properties: {
          tags: { type: 'array', items: STRING },
          users: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: STRING },
              required: ['name'],
            },
          },
        },
        required: ['tags', 'users'],
      },
      STRING
    );
    expect(content).toContain('tags: string[];');
    expect(content).toContain('users: DemoApiCreateUsersInputUsers[];');
    expect(content).toContain('export interface DemoApiCreateUsersInputUsers {');
    expect(content).toContain('name: string;');
  });
});

// ---------------------------------------------------------------------------
// 4. Enums
// ---------------------------------------------------------------------------

describe('enums', () => {
  it('emits string-literal unions and collapses [true,false] to boolean', () => {
    const content = emit(
      'demo-api',
      'listUsers',
      {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['admin', 'user'] },
          flags: { type: 'boolean', enum: [true, false] },
        },
        required: ['role', 'flags'],
      },
      { type: 'array', items: STRING }
    );
    expect(content).toContain("role: 'admin' | 'user';");
    expect(content).toContain('flags: boolean;');
    expect(content).toContain('export type DemoApiListUsersOutput = string[];');
  });
});

// ---------------------------------------------------------------------------
// 5. $ref / definitions
// ---------------------------------------------------------------------------

describe('$ref and definitions', () => {
  it('resolves $ref against the schema definitions dict and emits the def', () => {
    const content = emit(
      'demo-api',
      'getUser',
      {
        type: 'object',
        properties: { user: { $ref: '#/definitions/User' } },
        required: ['user'],
        definitions: {
          User: {
            type: 'object',
            properties: { id: STRING },
            required: ['id'],
          },
        },
      },
      STRING
    );
    expect(content).toContain('export interface User {');
    expect(content).toContain('id: string;');
    expect(content).toContain('user: User;');
  });
});

// ---------------------------------------------------------------------------
// 6. Discriminated union (hand-built `_batch` shape) — the authoritative union proof
// ---------------------------------------------------------------------------

describe('discriminated union (oneOf + discriminator)', () => {
  const unionOutput = {
    oneOf: [
      {
        type: 'object',
        properties: {
          operation: { const: 'cat' },
          content: STRING,
        },
        required: ['operation', 'content'],
      },
      {
        type: 'object',
        properties: {
          operation: { const: 'dog' },
          path: STRING,
          sizeBytes: { type: 'number' },
        },
        required: ['operation', 'path', 'sizeBytes'],
      },
    ],
    discriminator: {
      propertyName: 'operation',
      mapping: { cat: '#/oneOf/0', dog: '#/oneOf/1' },
    },
  };

  it('emits a named union + per-branch interfaces with the discriminant retained, never any/unknown', () => {
    const content = emit(
      'demo-api',
      'runTask',
      {
        type: 'object',
        properties: { task: unionOutput },
        required: ['task'],
      },
      unionOutput
    );
    expect(content).toContain(
      'export type DemoApiRunTaskOutput = DemoApiRunTaskOutputCat | DemoApiRunTaskOutputDog;'
    );
    expect(content).toContain('export interface DemoApiRunTaskOutputCat {');
    expect(content).toContain("operation: 'cat';");
    expect(content).toContain('content: string;');
    expect(content).toContain('export interface DemoApiRunTaskOutputDog {');
    expect(content).toContain("operation: 'dog';");
    expect(content).toContain('path: string;');
    expect(content).toContain('sizeBytes: number;');
    // The union path must never degrade to `any`/`unknown`.
    expect(content).not.toContain('any');
    expect(content).not.toContain('unknown');
  });

  it('falls back to <name>Branch<i> when the mapping is absent', () => {
    const content = emit(
      'demo-api',
      'runTask',
      { type: 'object', properties: {}, required: [] },
      {
        oneOf: [
          {
            type: 'object',
            properties: { kind: { const: 'a' } },
            required: ['kind'],
          },
          {
            type: 'object',
            properties: { kind: { const: 'b' } },
            required: ['kind'],
          },
        ],
        discriminator: { propertyName: 'kind' },
      }
    );
    expect(content).toContain(
      'export type DemoApiRunTaskOutput = DemoApiRunTaskOutputBranch0 | DemoApiRunTaskOutputBranch1;'
    );
    expect(content).toContain('export interface DemoApiRunTaskOutputBranch0 {');
    expect(content).toContain('export interface DemoApiRunTaskOutputBranch1 {');
  });
});

// ---------------------------------------------------------------------------
// 6b. Nullable union — the extractor's optional-member spelling
// ---------------------------------------------------------------------------

describe('nullable union (extractor optional-member spelling)', () => {
  it('emits `T | null` for a oneOf containing a {type:null} branch (no discriminator)', () => {
    const content = emit(
      'demo-api',
      'getUser',
      {
        type: 'object',
        properties: { userId: STRING },
        required: ['userId'],
      },
      {
        type: 'object',
        properties: {
          id: STRING,
          // What the real extractor produces for `name?: string`.
          name: {
            oneOf: [{ type: 'null' }, STRING],
            'x-apigen-logical': 'union',
          },
        },
        required: ['id'],
      }
    );
    expect(content).toContain('id: string;');
    expect(content).toContain('name?: string | null;');
  });

  it('names object branches <RootName>Item for a root nullable union', () => {
    const content = emit(
      'demo-api',
      'getTask',
      { type: 'object', properties: {}, required: [] },
      {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: { id: STRING },
            required: ['id'],
          },
        ],
        'x-apigen-logical': 'union',
      }
    );
    expect(content).toContain('export type DemoApiGetTaskOutput = DemoApiGetTaskOutputItem | null;');
    expect(content).toContain('export interface DemoApiGetTaskOutputItem {');
    expect(content).toContain('id: string;');
  });
});

// ---------------------------------------------------------------------------
// 7. sanitizeIdentifier is load-bearing (hyphenated package ids)
// ---------------------------------------------------------------------------

describe('sanitizeIdentifier is load-bearing', () => {
  it('emits package-qualified identifiers from a hyphenated pkg id with no stray hyphens', () => {
    const out = tsTypesPlugin.generate(
      opsInput('dispatch-cli', [
        [
          'validate',
          {
            type: 'object',
            properties: { config: STRING },
            required: ['config'],
          },
          STRING,
        ],
      ])
    );
    expect(out.files[0].path).toBe('dispatch-cli/validate.ts');
    expect(out.files[0].content).toContain('DispatchCliValidateInput');
    expect(out.files[0].content).toContain('DispatchCliValidateOutput');
    // No hyphen inside any identifier position — the generated code lines
    // (comments may legitimately mention `ts-types`) must be hyphen-free.
    const codeOnly = out.files[0].content
      .split('\n')
      .filter((l) => l.trim().startsWith('export'))
      .join('\n');
    expect(codeOnly).not.toContain('-');
  });

  it('typeName / pkgPrefixFor produce the documented spellings', () => {
    expect(typeName('DispatchCli', 'validate', 'Output')).toBe(
      'DispatchCliValidateOutput'
    );
    expect(typeName('DispatchCli', 'validate', 'Input')).toBe(
      'DispatchCliValidateInput'
    );
    expect(pkgPrefixFor('dispatch-cli')).toBe('DispatchCli');
  });
});

// ---------------------------------------------------------------------------
// 8. Rejections — every unsupported construct throws with its message fragment
// ---------------------------------------------------------------------------

describe('rejections (round-1 contract)', () => {
  const input = { type: 'object', properties: {}, required: [] };

  it.each<[string, unknown, string]>([
    ['allOf', { allOf: [] }, 'allOf is not supported (round 1)'],
    ['anyOf', { anyOf: [] }, 'anyOf is not supported (round 1)'],
    [
      'oneOf without discriminator',
      { oneOf: [] },
      'oneOf without discriminator is not supported (round 1)',
    ],
    [
      'patternProperties',
      { type: 'object', patternProperties: { '^x': STRING } },
      'patternProperties is not supported (round 1)',
    ],
    [
      'additionalProperties with a schema value',
      { type: 'object', additionalProperties: STRING },
      'additionalProperties schema is not supported (round 1)',
    ],
    [
      'unresolvable $ref',
      { $ref: '#/definitions/Missing' },
      'unresolvable $ref: #/definitions/Missing',
    ],
  ])('%s throws', (_label, output, fragment) => {
    expect(() => emitFnTypes('DemoApi', 'runTask', { input, output })).toThrow(
      fragment
    );
  });

  it('prefixes errors with [apigen-plugin-ts-types] and carries fn + path', () => {
    let err: unknown;
    try {
      emitFnTypes('DemoApi', 'runTask', {
        input,
        output: { allOf: [] },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[apigen-plugin-ts-types]');
    expect((err as Error).message).toContain('(fn: runTask, path: output)');
  });

  it('accepts additionalProperties: false (a constraint, not a schema)', () => {
    const content = emit(
      'demo-api',
      'getUser',
      {
        type: 'object',
        properties: { userId: STRING },
        required: ['userId'],
        additionalProperties: false,
      },
      STRING
    );
    expect(content).toContain('userId: string;');
  });

  it('rejects a non-object oneOf branch instead of degrading', () => {
    expect(() =>
      emitFnTypes('DemoApi', 'runTask', {
        input,
        output: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          discriminator: {
            propertyName: 'kind',
            mapping: { a: '#/oneOf/0', b: '#/oneOf/1' },
          },
        },
      })
    ).toThrow('oneOf branch is not an object schema (discriminated union)');
  });
});

// ---------------------------------------------------------------------------
// 9. pkg.schemas fallback — data wrapper is dissolved
// ---------------------------------------------------------------------------

describe('pkg.schemas fallback with data-wrapper unwrap', () => {
  it('emits the inner params, never a `data` member, when operations is absent', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'demo-api',
          schemas: {
            getUser: {
              input: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    properties: { userId: STRING },
                    required: ['userId'],
                  },
                },
                required: ['data'],
              },
              output: {
                type: 'object',
                properties: { id: STRING },
                required: ['id'],
              },
            },
          },
          importPath: 'demo-api',
        },
      ],
      outputDir: '.',
      options: {},
    };
    const out = tsTypesPlugin.generate(input);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('demo-api/getUser.ts');
    const content = out.files[0].content;
    expect(content).toContain('userId: string;');
    expect(content).not.toContain('data');
  });

  it('unwrapDataWrapper is a no-op for flat (non-wrapped) schemas', () => {
    const flat = { type: 'object', properties: { x: STRING }, required: ['x'] };
    expect(unwrapDataWrapper(flat)).toBe(flat);
    expect(unwrapDataWrapper('nope')).toBe('nope');
    expect(unwrapDataWrapper(null)).toBeNull();
  });

  it('operations win over pkg.schemas on name collision', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'demo-api',
          schemas: {
            getUser: {
              input: {
                type: 'object',
                properties: { data: { type: 'object' } },
                required: ['data'],
              },
              output: STRING,
            },
          },
          importPath: 'demo-api',
        },
      ],
      outputDir: '.',
      options: {},
      operations: [
        op(
          'getUser',
          {
            type: 'object',
            properties: { fromOps: STRING },
            required: ['fromOps'],
          },
          STRING
        ),
      ],
    };
    const out = tsTypesPlugin.generate(input);
    expect(out.files[0].content).toContain('fromOps: string;');
    expect(out.files[0].content).not.toContain('data');
  });
});

// ---------------------------------------------------------------------------
// 10. Plugin object contract
// ---------------------------------------------------------------------------

describe('plugin object', () => {
  it('is a generate-only OutputPlugin with id ts-types', () => {
    expect(tsTypesPlugin.id).toBe('ts-types');
    expect(tsTypesPlugin.language).toBe('ts');
    expect(typeof tsTypesPlugin.generate).toBe('function');
    expect(tsTypesPlugin.run).toBeUndefined();
    expect(tsTypesPlugin.optionsSchema).toEqual({ type: 'object', properties: {} });
  });

  it('emits one file per fn at <pkgId>/<fnName>.ts for a 2-fn input', () => {
    const out = tsTypesPlugin.generate(
      opsInput('demo-api', [
        [
          'getUser',
          { type: 'object', properties: { id: STRING }, required: ['id'] },
          STRING,
        ],
        [
          'listUsers',
          { type: 'object', properties: {}, required: [] },
          { type: 'array', items: STRING },
        ],
      ])
    );
    expect(out.files.map((f) => f.path).sort()).toEqual([
      'demo-api/getUser.ts',
      'demo-api/listUsers.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 11. Compile check + negative control (esbuild transform, never node --check)
// ---------------------------------------------------------------------------

describe('esbuild compile check + negative control', () => {
  it('every emitted file transforms as valid TS; a hyphen splice rejects', async () => {
    const out = tsTypesPlugin.generate(
      opsInput('dispatch-cli', [
        [
          'validate',
          {
            type: 'object',
            properties: { config: STRING },
            required: ['config'],
          },
          STRING,
        ],
        [
          'runTask',
          {
            type: 'object',
            properties: { task: { type: 'string' } },
            required: ['task'],
          },
          {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { const: 'a' }, content: STRING },
                required: ['kind', 'content'],
              },
              {
                type: 'object',
                properties: { kind: { const: 'b' }, path: STRING },
                required: ['kind', 'path'],
              },
            ],
            discriminator: {
              propertyName: 'kind',
              mapping: { a: '#/oneOf/0', b: '#/oneOf/1' },
            },
          },
        ],
      ])
    );
    expect(out.files).toHaveLength(2);

    for (const file of out.files) {
      await expect(
        transform(file.content, { loader: 'ts' }),
        `file ${file.path} must transform as valid TS`
      ).resolves.toBeDefined();
    }

    // Negative control: mutate a sanitized type name with a bare `-` splice.
    const bad = out.files[0].content.replace(
      'DispatchCliValidateInput',
      'DispatchCli-ValidateInput'
    );
    expect(bad).not.toBe(out.files[0].content);
    await expect(transform(bad, { loader: 'ts' })).rejects.toThrow();
  });
});
