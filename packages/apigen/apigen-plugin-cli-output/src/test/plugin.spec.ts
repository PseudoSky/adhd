import { describe, it, expect } from 'vitest';
import { cliPlugin } from '../lib/plugin';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

/** Composed schema with session middleware and a required string param. */
function makeSessionSchema(
  paramName: string,
  paramType: string,
  required: boolean
) {
  return {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            [paramName]: { type: paramType },
          },
          ...(required ? { required: [paramName] } : {}),
        },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
  };
}

/** Composed schema WITHOUT session (envelope override suppresses it). */
function makeNoSessionSchema(
  paramName: string,
  paramType: string,
  required: boolean
) {
  return {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            [paramName]: { type: paramType },
          },
          ...(required ? { required: [paramName] } : {}),
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  };
}

/**
 * Schema with an explicit x-apigen-envelope mapping (pluginId per field).
 * Models the v2 descriptor-driven envelope metadata (§9.1).
 */
function makeEnvelopeSchema(
  envelopeFields: Record<string, string>, // field → pluginId
  paramName: string,
  paramType: string,
  required: boolean
) {
  const envelopeProps: Record<string, unknown> = {};
  for (const field of Object.keys(envelopeFields)) {
    envelopeProps[field] = { type: 'string' };
  }
  return {
    input: {
      type: 'object',
      properties: {
        ...envelopeProps,
        data: {
          type: 'object',
          properties: {
            [paramName]: { type: paramType },
          },
          ...(required ? { required: [paramName] } : {}),
        },
      },
      required: [...Object.keys(envelopeFields), 'data'],
    },
    output: { type: 'object' },
    // §9.1 — x-apigen-envelope maps field → pluginId so the generator can
    // emit the canonical --<pluginId>-<field> flag and APIGEN_<PLUGINID>_<FIELD> env var.
    'x-apigen-envelope': envelopeFields,
  };
}

function makeInput(overrides: Partial<PluginInput> = {}): PluginInput {
  return {
    packages: [],
    outputDir: '/tmp/out',
    options: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plugin shape tests
// ---------------------------------------------------------------------------

describe('cliPlugin shape', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof cliPlugin.id).toBe('string');
    expect(cliPlugin.id).toBe('cli');
    expect(typeof cliPlugin.generate).toBe('function');
  });

  // [plugin-cli-output.6] Plugin has no run() method (generate-only plugin).
  it('has no run() method (generate-only plugin)', () => {
    expect(cliPlugin.run).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generate() behavioral tests
// ---------------------------------------------------------------------------

describe('generate()', () => {
  // [plugin-cli-output.1] generate() emits cli.ts with one .command('fnName') per function.
  it('emits cli.ts with .command() for each function', () => {
    const input = makeInput({
      packages: [
        {
          id: 'myPkg',
          importPath: '@acme/my-pkg',
          schemas: {
            getUser: makeNoSessionSchema('userId', 'string', true),
            listUsers: makeNoSessionSchema('limit', 'number', false),
          },
        },
      ],
    });
    const output = generate(input);

    expect(output.files).toHaveLength(1);
    const { path, content } = output.files[0];
    expect(path).toBe('cli.ts');
    expect(content).toContain(".command('getUser')");
    expect(content).toContain(".command('listUsers')");
  });

  // [plugin-cli-output.5] dispatch is imported from @adhd/apigen-engine-runtime — not inlined.
  it('imports dispatch from @adhd/apigen-engine-runtime, not inlined', () => {
    const input = makeInput({
      packages: [
        {
          id: 'myPkg',
          importPath: '@acme/my-pkg',
          schemas: { ping: makeNoSessionSchema('x', 'string', false) },
        },
      ],
    });
    const { content } = generate(input).files[0];
    // Must import dispatch from the runtime package
    expect(content).toMatch(
      /import \{[^}]*\bdispatch\b[^}]*\} from ['"]@adhd\/apigen-engine-runtime['"]/
    );
    // Must not contain a function body that could be an inlined dispatch
    expect(content).not.toMatch(/function dispatch\s*\(/);
  });

  // [plugin-cli-output.3] Required params use .requiredOption(); optional use .option().
  it('uses requiredOption for required params and option for optional params', () => {
    const input = makeInput({
      packages: [
        {
          id: 'svc',
          importPath: '@acme/svc',
          schemas: {
            create: makeNoSessionSchema('name', 'string', true),
            search: makeNoSessionSchema('query', 'string', false),
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).toContain(".requiredOption('--name <name>')");
    expect(content).toContain(".option('--query <query>')");
  });

  // [plugin-cli-output.2] Boolean params produce .option('--<param>') (no <value> placeholder).
  it('uses .option() without <value> placeholder for boolean params', () => {
    const input = makeInput({
      packages: [
        {
          id: 'svc',
          importPath: '@acme/svc',
          schemas: {
            doThing: makeNoSessionSchema('verbose', 'boolean', false),
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    // Boolean: no <value> placeholder
    expect(content).toContain(".option('--verbose')");
    // Must NOT use requiredOption or a value placeholder for boolean
    expect(content).not.toContain(".requiredOption('--verbose");
    expect(content).not.toContain('--verbose <verbose>');
  });

  // [plugin-cli-output.4] §9.1: session field → --adhd-session flag (builtin adhd plugin drops segment from env var).
  // The canonical CLI flag for envelope field 'session' with pluginId='adhd' is --adhd-session.
  it('[v2] adds --adhd-session flag when session middleware is present (§9.1)', () => {
    const input = makeInput({
      packages: [
        {
          id: 'svc',
          importPath: '@acme/svc',
          schemas: {
            getUser: makeSessionSchema('userId', 'string', true),
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    // §9.1: builtin adhd fields → --adhd-<field>
    expect(content).toContain('--adhd-session');
  });

  // [plugin-cli-output.4] (negative) No session middleware → no --session or --adhd-session flag.
  it('omits session flag when session middleware is absent', () => {
    const input = makeInput({
      packages: [
        {
          id: 'svc',
          importPath: '@acme/svc',
          schemas: {
            ping: makeNoSessionSchema('x', 'string', false),
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).not.toContain('--session');
    expect(content).not.toContain('--adhd-session');
  });

  it('uses options.name and options.version in the generated program', () => {
    const input = makeInput({
      packages: [],
      options: { name: 'my-tool', version: '2.5.0' },
    });
    const { content } = generate(input).files[0];
    expect(content).toContain(".name('my-tool')");
    expect(content).toContain(".version('2.5.0')");
  });

  it('defaults to name=cli and version=0.1.0', () => {
    const input = makeInput({ packages: [] });
    const { content } = generate(input).files[0];
    expect(content).toContain(".name('cli')");
    expect(content).toContain(".version('0.1.0')");
  });

  it('imports function modules for each package', () => {
    const input = makeInput({
      packages: [
        {
          id: 'pkgA',
          importPath: '@acme/pkg-a',
          schemas: { fn1: makeNoSessionSchema('x', 'string', false) },
        },
        {
          id: 'pkgB',
          importPath: '@acme/pkg-b',
          schemas: { fn2: makeNoSessionSchema('y', 'string', false) },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).toContain("import * as pkgA_ns from '@acme/pkg-a'");
    expect(content).toContain("import * as pkgB_ns from '@acme/pkg-b'");
  });

  it('ends with program.parseAsync()', () => {
    const input = makeInput({ packages: [] });
    const { content } = generate(input).files[0];
    expect(content.trimEnd()).toMatch(/program\.parseAsync\(\)\s*$/);
  });

  it('embeds schemas as JSON in the generated file', () => {
    const schema = makeNoSessionSchema('id', 'string', true);
    const input = makeInput({
      packages: [
        {
          id: 'myPkg',
          importPath: '@acme/my-pkg',
          schemas: { getUser: schema },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).toContain('"myPkg:getUser"');
  });

  it('calls dispatch with correct package fns, schema key, and fnName', () => {
    const input = makeInput({
      packages: [
        {
          id: 'svc',
          importPath: '@acme/svc',
          schemas: {
            doStuff: makeNoSessionSchema('item', 'string', true),
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).toContain(
      "dispatch(svc_fns as any, undefined, schemas['svc:doStuff'] as any, 'doStuff'"
    );
  });

  // ---------------------------------------------------------------------------
  // [v2-proj-transport] §9.1 Envelope binding — CLI transport (flag + env var)
  // ---------------------------------------------------------------------------

  describe('[v2-proj-transport] §9.1 CLI envelope binding', () => {
    it('[cli-env.1] named plugin field → --<pluginId>-<field> flag and APIGEN_<PLUGINID>_<FIELD> env', () => {
      // auth plugin contributes 'token' field → --auth-token + APIGEN_AUTH_TOKEN
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              doThing: makeEnvelopeSchema(
                { token: 'auth' },
                'id',
                'string',
                true
              ),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain('--auth-token');
      expect(content).toContain('APIGEN_AUTH_TOKEN');
    });

    it('[cli-env.2] builtin adhd field → --adhd-<field> flag and APIGEN_<FIELD> env (no plugin segment)', () => {
      // session field with pluginId='adhd' → --adhd-session + APIGEN_SESSION
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              getUser: makeEnvelopeSchema(
                { session: 'adhd' },
                'userId',
                'string',
                true
              ),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain('--adhd-session');
      expect(content).toContain('APIGEN_SESSION');
    });

    it('[cli-env.3] (negative) wrong carrier: envelope NOT in --<param> positional args', () => {
      // The envelope flag must use the --<pluginId>-<field> form; plain --<field> must not appear
      // as the env carrier when x-apigen-envelope is set.
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              doThing: makeEnvelopeSchema(
                { token: 'auth' },
                'id',
                'string',
                true
              ),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      // envelope field 'token' must NOT appear as a domain --token option
      expect(content).not.toContain(".requiredOption('--token");
      expect(content).not.toContain(".option('--token <token>')");
      // It MUST appear as the correct §9.1 carrier
      expect(content).toContain('--auth-token');
    });

    it('[cli-env.4] flag takes precedence over env — both are emitted in action body', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              act: makeEnvelopeSchema({ token: 'auth' }, 'x', 'string', false),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      // The action body must contain `?? process.env['APIGEN_AUTH_TOKEN']` to honor flag>env precedence
      expect(content).toContain("?? process.env['APIGEN_AUTH_TOKEN']");
    });
  });
});

  // ---------------------------------------------------------------------------
  // BUG-APIGEN-031: array/object domain params must be JSON.parse'd before
  // reaching dispatch — the CLI transport's wire values are always raw argv
  // strings, unlike HTTP transports which already deliver a real parsed value.
  // ---------------------------------------------------------------------------

  describe('BUG-APIGEN-031: array/object domain param JSON parsing', () => {
    /** Extracts the generated `__apigenParseJsonArg` helper as a callable fn. */
    function extractJsonParseHelper(
      content: string
    ): (flag: string, raw: unknown) => unknown {
      const match = content.match(/function __apigenParseJsonArg[\s\S]*?\n}/);
      if (!match) throw new Error('helper not found in generated output');
      // Strip the TS parameter/return type annotations (generated cli.ts is
      // TypeScript; `new Function` only accepts plain JS) so the extracted
      // source can be evaluated directly — proves the actual shipped runtime
      // behavior rather than a hand-copied reimplementation of it.
      const jsSource = match[0]
        .replace('(flag: string, raw: unknown): unknown', '(flag, raw)')
        .replace('(err as Error).message', 'err.message');
      // eslint-disable-next-line no-new-func
      return new Function(`return (${jsSource})`)();
    }

    it('wraps an array-typed required param in __apigenParseJsonArg, keyed by its kebab flag', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: { mean: makeNoSessionSchema('arr', 'array', true) },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain(
        `'arr': __apigenParseJsonArg('arr', opts['arr'])`
      );
    });

    it('wraps an object-typed param in __apigenParseJsonArg', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              configure: makeNoSessionSchema('options', 'object', false),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain(
        `'options': __apigenParseJsonArg('options', opts['options'])`
      );
    });

    it('does NOT wrap scalar-typed params (string/number/boolean)', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              act: makeNoSessionSchema('name', 'string', true),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain(`'name': opts['name']`);
      expect(content).not.toContain('__apigenParseJsonArg');
    });

    it('omits the helper function entirely when no command has an array/object param', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: { act: makeNoSessionSchema('name', 'string', true) },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).not.toContain('function __apigenParseJsonArg');
    });

    it('wraps a nullable array param (anyOf: [array, null])', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              search: {
                input: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        tags: { anyOf: [{ type: 'array' }, { type: 'null' }] },
                      },
                    },
                  },
                  required: ['data'],
                },
                output: { type: 'object' },
              },
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      expect(content).toContain(
        `'tags': __apigenParseJsonArg('tags', opts['tags'])`
      );
    });

    it('the generated helper correctly parses a real array-typed argv string (regression: mean --arr crashed with "arr.reduce is not a function")', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: { mean: makeNoSessionSchema('arr', 'array', true) },
          },
        ],
      });
      const { content } = generate(input).files[0];
      const parse = extractJsonParseHelper(content);
      expect(parse('arr', '[2,4,6]')).toEqual([2, 4, 6]);
    });

    it('the generated helper correctly parses a real object-typed argv string', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: {
              configure: makeNoSessionSchema('options', 'object', false),
            },
          },
        ],
      });
      const { content } = generate(input).files[0];
      const parse = extractJsonParseHelper(content);
      expect(parse('options', '{"verbose":true}')).toEqual({ verbose: true });
    });

    it('the generated helper passes an omitted (undefined) optional param through unchanged', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: { mean: makeNoSessionSchema('arr', 'array', false) },
          },
        ],
      });
      const { content } = generate(input).files[0];
      const parse = extractJsonParseHelper(content);
      expect(parse('arr', undefined)).toBeUndefined();
    });

    it('the generated helper throws a clear, flag-named error for malformed JSON instead of silently passing the raw string through (regression: percentile --sorted returned a coincidentally-plausible wrong answer via string indexing)', () => {
      const input = makeInput({
        packages: [
          {
            id: 'svc',
            importPath: '@acme/svc',
            schemas: { mean: makeNoSessionSchema('arr', 'array', true) },
          },
        ],
      });
      const { content } = generate(input).files[0];
      const parse = extractJsonParseHelper(content);
      expect(() => parse('arr', '[10,20,30,40,50]not-json')).toThrow(
        /Invalid JSON for --arr/
      );
    });
  });

describe('cli plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(cliPlugin.language).toBe('ts');
  });
});
