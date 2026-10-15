import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { generate } from '../lib/generate';
import { mcpPlugin } from '../lib/plugin';
import type {
  Operation,
  PluginInput,
  RunInput,
  Segment,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { operationFor } from '../lib/tool-naming';

/** Test-local stand-in for the old `deriveToolName` — mirrors generate.ts's
 * own `operationFor(...) -> project(...).mcp.name` pipeline exactly, so these
 * tests stay decoupled from generate.ts's internals while still computing the
 * SAME expected value generate.ts derives internally via `buildOpPlan`. */
function deriveToolName(
  pkg: { id: string; importPath: string },
  fnName: string,
  operations?: Operation[]
): string {
  return project(operationFor(pkg, fnName, operations)).mcp.name;
}

// ---------- fixture ----------
// Simple domain functions — schemas follow ComposedSchemas shape (data-wrapped).
const testSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
  listUsers: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'array' },
  },
};

/** Schema with session envelope field + x-apigen-envelope metadata (§9.1). */
const envelopeSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
    'x-apigen-envelope': { session: 'auth' },
  },
};

const baseInput: PluginInput = {
  packages: [
    {
      id: 'test-pkg',
      schemas: testSchema,
      importPath: '@test/test-pkg',
    },
  ],
  outputDir: '/tmp/out',
  options: {},
};

// ---------- generate() — stdio ----------

describe('[plugin-mcp.1] generate() — stdio transport', () => {
  it('emits index.ts and server.ts', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } });
    expect(out.files).toHaveLength(2);
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain('index.ts');
    expect(paths).toContain('server.ts');
  });

  it('server.ts contains StdioServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).toContain('StdioServerTransport');
  });

  it('index.ts contains toolMetas with fixture fn names', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } });
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');
    expect(idx.content).toContain('getUser');
    expect(idx.content).toContain('listUsers');
    expect(idx.content).toContain('toolMetas');
    expect(idx.content).toContain('groupFns');
    expect(idx.content).toContain('groupCreateClient');
  });

  it('server.ts imports dispatch from @adhd/apigen-engine-runtime', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).toContain("from '@adhd/apigen-engine-runtime'");
    expect(server.content).toContain('dispatch');
  });

  it('defaults to stdio when no transport option given', () => {
    const out = generate(baseInput);
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).toContain('StdioServerTransport');
  });
});

// ---------- generate() — SSE ----------

describe('[plugin-mcp.2] generate() — sse transport', () => {
  it('server.ts contains SSEServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'sse' } });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).toContain('SSEServerTransport');
  });

  it('does NOT contain StdioServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'sse' } });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).not.toContain('StdioServerTransport');
  });
});

// ---------- generate() — streaming-http ----------

describe('[plugin-mcp.3] generate() — streaming-http transport', () => {
  it('server.ts contains StreamableHTTPServerTransport', () => {
    const out = generate({
      ...baseInput,
      options: { transport: 'streaming-http' },
    });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).toContain('StreamableHTTPServerTransport');
  });

  it('does NOT contain StdioServerTransport or SSEServerTransport', () => {
    const out = generate({
      ...baseInput,
      options: { transport: 'streaming-http' },
    });
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    expect(server.content).not.toContain('StdioServerTransport');
    expect(server.content).not.toContain('SSEServerTransport');
  });
});

// ---------- plugin interface ----------

describe('[plugin-mcp.6] mcpPlugin — optionsSchema transport enum', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(mcpPlugin.id).toBe('mcp');
    expect(typeof mcpPlugin.generate).toBe('function');
    expect(typeof mcpPlugin.run).toBe('function');
  });

  it('optionsSchema.properties.transport.enum contains all 3 transports', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = mcpPlugin.optionsSchema as any;
    const enumValues: string[] = schema.properties.transport.enum;
    expect(enumValues).toContain('stdio');
    expect(enumValues).toContain('sse');
    expect(enumValues).toContain('streaming-http');
  });

  it('delegates generate() to the generate module', () => {
    const out = mcpPlugin.generate(baseInput);
    expect((out as { files: unknown[] }).files).toHaveLength(2);
  });
});

// ---------- [plugin-mcp.5] no inline dispatch ----------

describe('[plugin-mcp.5] no inline dispatch logic in generate output', () => {
  it('index.ts does not contain dispatch implementation', () => {
    const out = generate(baseInput);
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');
    // index.ts is a data file — it must not contain any dispatch call
    expect(idx.content).not.toContain('dispatch(');
  });
});

// ---------- [plugin-mcp.7] BUG-APIGEN-017/018/019/020 — generated server.ts wiring ----------

describe('[plugin-mcp.7] generated server.ts — MCP schema-hardening wiring', () => {
  it('ADR-0004: stdio/sse/streaming-http server.ts wire outputSchema + structuredContent, never a {result} envelope', () => {
    for (const transport of ['stdio', 'sse', 'streaming-http'] as const) {
      const out = generate({ ...baseInput, options: { transport } });
      const server = out.files.find((f) => f.path === 'server.ts');
      expect(server).toBeDefined();
      if (!server) throw new Error('Expected server.ts');
      expect(server.content).toContain('buildMcpOutputSchema');
      expect(server.content).toContain('wrapMcpStructuredContent');
      expect(server.content).toContain("from '@adhd/apigen-engine-runtime'");
      // Wired into both the tools/list outputSchema field and the tools/call
      // structuredContent field, not just imported-and-unused.
      expect(server.content).toContain('outputSchema');
      expect(server.content).toContain('structuredContent');
      // ADR-0004: the generated host must NOT manufacture the old wrap schema
      // (`{type:'object', properties:{ result: <output> }, …}`) — non-object
      // returns are passed through flat on `content`.
      expect(server.content).not.toMatch(/properties:\s*\{\s*result/);
    }
  });

  it('BUG-APIGEN-017: generated index.ts preserves additionalProperties:false on a fixture schema', () => {
    const restrictiveSchema = {
      getUser: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { userId: { type: 'string' } },
              required: ['userId'],
              additionalProperties: false,
            },
          },
          required: ['data'],
          additionalProperties: false,
        },
        output: { type: 'object' },
      },
    };
    const out = generate({
      ...baseInput,
      packages: [
        {
          id: 'test-pkg',
          schemas: restrictiveSchema,
          importPath: '@test/test-pkg',
        },
      ],
    });
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');
    // JSON.stringify(fnSchema) bakes the schema verbatim — additionalProperties:false
    // must survive generate() unmodified (it is not stripped or overridden).
    expect(idx.content).toContain('"additionalProperties":false');
  });

  it('BUG-APIGEN-018 (mcp): generated tool description surfaces a per-param default value note', () => {
    const schemaWithDefault = {
      search: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                strategy: {
                  type: 'string',
                  default: 'auto',
                  description: '(default: auto)',
                },
              },
              required: [],
            },
          },
          required: ['data'],
        },
        output: { type: 'object' },
      },
    };
    const out = generate({
      ...baseInput,
      packages: [
        {
          id: 'test-pkg',
          schemas: schemaWithDefault,
          importPath: '@test/test-pkg',
        },
      ],
    });
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');
    // The per-param default note lives on the nested property schema and must
    // survive generate() unmodified — it's baked into the schema JSON.
    expect(idx.content).toContain('default: auto');
  });

  it('BUG-APIGEN-020: generated tool description includes the envelope calling-convention note', () => {
    const schemaWithEnvelopeDoc = {
      search: {
        input: {
          type: 'object',
          properties: {
            data: { type: 'object', properties: {}, required: [] },
          },
          required: ['data'],
          description:
            'apigen calling convention: all domain parameters go inside a "data" envelope.',
        },
        output: { type: 'object' },
      },
    };
    const out = generate({
      ...baseInput,
      packages: [
        {
          id: 'test-pkg',
          schemas: schemaWithEnvelopeDoc,
          importPath: '@test/test-pkg',
        },
      ],
    });
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');
    expect(idx.content).toContain('description:');
    expect(idx.content).toContain('data');
    expect(idx.content).toContain('envelope');
  });
});

// ---------- [v2-proj-transport] MCP envelope binding in generated server.ts ----------

describe('[v2-proj-transport] §9.1 MCP envelope binding in generated server.ts', () => {
  it('[v2-mcp.gen.env.1] generated server.ts reads envelope from _meta["x-<pluginId>-<field>"]', () => {
    const input: PluginInput = {
      packages: [
        { id: 'svc', schemas: envelopeSchema, importPath: '@acme/svc' },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'stdio' },
    };
    const out = generate(input);
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    // §9.1: MCP envelope uses _meta key convention
    expect(server.content).toContain('_meta');
    // The generated extractEnvelope function must build 'x-auth-session' key
    expect(server.content).toContain('x-apigen-envelope');
  });

  it('[v2-mcp.gen.env.2] (negative) generated server.ts does NOT spread args as envelope', () => {
    const input: PluginInput = {
      packages: [
        { id: 'svc', schemas: envelopeSchema, importPath: '@acme/svc' },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'stdio' },
    };
    const out = generate(input);
    const server = out.files.find((f) => f.path === 'server.ts');
    expect(server).toBeDefined();
    if (!server) throw new Error('Expected server.ts');
    // Old v1 pattern: dispatch(... args as Record ..., ((args as any)['data'] ...))
    // where args (the full args including envelope fields) is passed as the envelope arg.
    // In v2, envelope is extracted from _meta separately and passed as its own arg.
    // The args object must NOT be used directly as the envelope argument.
    expect(server.content).not.toMatch(
      /dispatch\([^,]+,[^,]+,[^,]+,[^,]+,\s*args as/
    );
  });

  it('[v2-mcp.gen.env.3] generated server.ts contains extractEnvelope helper for all transports', () => {
    for (const transport of ['stdio', 'sse', 'streaming-http'] as const) {
      const input: PluginInput = {
        packages: [
          { id: 'svc', schemas: envelopeSchema, importPath: '@acme/svc' },
        ],
        outputDir: '/tmp/out',
        options: { transport },
      };
      const out = generate(input);
      const server = out.files.find((f) => f.path === 'server.ts');
      expect(server).toBeDefined();
      if (!server) throw new Error('Expected server.ts');
      expect(server.content).toContain('extractEnvelope');
    }
  });
});

// ---------- [BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] canonical MCP naming in generate() ----------

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] generate() derives canonical MCP tool names', () => {
  it('keys toolMetas by project(op).mcp.name (best-effort fallback path — no operations supplied)', () => {
    const out = generate(baseInput);
    const idx = out.files.find((f) => f.path === 'index.ts');
    expect(idx).toBeDefined();
    if (!idx) throw new Error('Expected index.ts');

    const getUserName = deriveToolName(
      { id: 'test-pkg', importPath: '@test/test-pkg' },
      'getUser'
    );
    const listUsersName = deriveToolName(
      { id: 'test-pkg', importPath: '@test/test-pkg' },
      'listUsers'
    );
    // Sanity: the derived names are genuinely canonical (not the raw fn name).
    expect(getUserName).not.toBe('getUser');
    expect(listUsersName).not.toBe('listUsers');

    expect(idx.content).toContain(JSON.stringify(getUserName));
    expect(idx.content).toContain(JSON.stringify(listUsersName));
    // Each entry retains the REAL fn name for dispatch (round-trip wiring —
    // see templates/server-*.tpl.ts's `dispatch(..., meta.fnName, ...)`).
    expect(idx.content).toContain(`fnName: "getUser"`);
    expect(idx.content).toContain(`fnName: "listUsers"`);
  });

  it('[negative control] toolMetas is NOT keyed by the OLD raw fn name', () => {
    const out = generate(baseInput);
    const idx = out.files.find((f) => f.path === 'index.ts');
    if (!idx) throw new Error('Expected index.ts');
    // The OLD (pre-fix) behavior keyed the object literal as `getUser: {...}`
    // / `listUsers: {...}` (bare identifier key === raw fn name). Assert that
    // exact key form is gone.
    expect(idx.content).not.toMatch(/\n\s*getUser:\s*\{/);
    expect(idx.content).not.toMatch(/\n\s*listUsers:\s*\{/);
  });

  it("matches run()'s EXACT-path derivation when given the same real Operation[] (cross-transport / generate-vs-run consistency)", () => {
    const namespaceSeg: Segment = { raw: 'catalog', words: ['catalog'] };
    const fileSeg: Segment = { raw: 'itemApi', words: ['item', 'api'] };
    const getItemOp: Operation = {
      id: 'catalog/item-api/getItem',
      host: 'ts',
      namespace: namespaceSeg,
      path: [fileSeg, { raw: 'getItem', words: ['get', 'item'] }],
      kind: 'action',
      async: false,
      streaming: false,
      safe: false,
      input: {},
      output: {},
      envelope: {},
      typeText: null,
    };
    const schema = {
      getItem: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { itemId: { type: 'string' } },
              required: ['itemId'],
            },
          },
          required: ['data'],
        },
        output: { type: 'object' },
      },
    };
    // A RunInput-shaped object is structurally a superset of PluginInput —
    // generate() reads `input.operations` directly (PluginInput carries it
    // natively since DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001 was
    // resolved; see generate.ts's comment).
    const input: RunInput = {
      packages: [
        { id: 'catalog', schemas: schema, importPath: '@acme/catalog' },
      ],
      outputDir: '/tmp/out',
      options: {},
      operations: [getItemOp],
    };
    const out = generate(input);
    const idx = out.files.find((f) => f.path === 'index.ts');
    if (!idx) throw new Error('Expected index.ts');

    const expectedName = project(getItemOp).mcp.name;
    expect(expectedName).toBe('catalog_item_api_get_item');
    expect(idx.content).toContain(JSON.stringify(expectedName));

    // The EXACT path (real Operation) and the best-effort fallback would
    // DIVERGE here (fallback can't see the 'itemApi' file segment from
    // importPath '@acme/catalog') — proving generate() actually used the
    // supplied `operations`, not silently falling back.
    const fallbackName = deriveToolName(
      { id: 'catalog', importPath: '@acme/catalog' },
      'getItem'
    );
    expect(fallbackName).not.toBe(expectedName);
    expect(idx.content).not.toContain(JSON.stringify(fallbackName));
  });
});

// ---------------------------------------------------------------------------
// Regression: hyphenated package ids spliced raw into index.ts identifiers (969e36f4)
// ---------------------------------------------------------------------------
//
// Test header
//   guards: generateIndex (the uniqueSanitizedIdentifiers call and the groupFns table) passes every
//     package id through uniqueSanitizedIdentifiers before it names the
//     import namespace and the fn table, so a hyphenated id emits parseable
//     TypeScript and a colliding pair of ids gets distinct identifiers. The
//     raw id stays in string-literal positions.
//   tier: S (unit). Pure string generation; the TypeScript parser runs
//     in-process. No subprocess, socket or network.
//   cites: 969e36f4 AC1, AC2, AC3 (identifier sanitisation), plus the
//     literal-escaping and duplicate-id guards added to the same function.
//     The ticket (969e36f4 body and notes) defines no numbered AC4; its only
//     further requirement is process ("negative control: revert, confirm
//     red"), which no test can assert and is recorded in the red line below.
//   tags: regression:969e36f4.
//   teeth: AC1 and AC2 fail on a286b457^, where `import * as data-base-transforms_ns`
//     is spliced raw and the parser reports syntax diagnostics.
//   red: pending (user hold; not run; must fail on a286b457^ for AC1 and AC2,
//     pass on the bucket head). AC3's byte-identical 'myPkg' case is a
//     characterization guard and passes on both sides. The escaping and
//     duplicate-id tests fail on a286b457 itself (raw splice, no guard) and
//     pass on the bucket head.
//   parser: ts.transpileModule with reportDiagnostics, the public API for
//     syntactic diagnostics. It reports the same parse errors as the
//     parser-level parseDiagnostics without reading a TypeScript internal.

/** Returns the syntactic diagnostics TypeScript reports for `source`; empty means it parses. */
function syntacticErrors(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: 'index.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')
  );
}

/**
 * Generates the index.ts content for the given package ids. With
 * `withPing` (the default) each package carries one `ping` function; without
 * it, the package has no functions, so index.ts has no toolMetas entries.
 */
function indexContentFor(
  pkgs: Array<{ id: string; importPath: string }>,
  withPing = true
): string {
  const input: PluginInput = {
    packages: pkgs.map((p) => ({
      id: p.id,
      importPath: p.importPath,
      schemas: withPing
        ? { ping: { input: { type: 'object', properties: {} }, output: { type: 'object' } } }
        : {},
      fns: withPing ? { ping: () => ({}) } : {},
    })),
    outputDir: '/tmp/out',
    options: {},
  };
  const idx = generate(input).files.find((f) => f.path === 'index.ts');
  if (!idx) throw new Error('Expected index.ts');
  return idx.content;
}

describe('regression:969e36f4 generate() — hyphenated package id in index.ts identifiers', () => {
  it('969e36f4 AC1: a hyphenated id ("data-base-transforms") yields index.ts that parses with zero syntax diagnostics', () => {
    const content = indexContentFor([
      { id: 'data-base-transforms', importPath: '@adhd/data-base-transforms' },
    ]);
    expect(syntacticErrors(content)).toEqual([]);
  });

  it('969e36f4 AC2: the import namespace and fn-table use the sanitized identifier; the raw id stays in the group key', () => {
    const content = indexContentFor([
      { id: 'data-base-transforms', importPath: '@adhd/data-base-transforms' },
    ]);
    expect(content).toContain('import * as data_base_transforms_ns');
    expect(content).toContain("'data-base-transforms': data_base_transforms_fns");
    expect(content).not.toContain('data-base-transforms_ns');
  });

  it('969e36f4 AC3: ids ["a-b","a_b"] get distinct declarations const a_b_fns and const a_b_2_fns, and the file parses', () => {
    const content = indexContentFor([
      { id: 'a-b', importPath: '@x/a-b' },
      { id: 'a_b', importPath: '@x/a_b' },
    ]);
    expect(content).toContain('const a_b_fns = buildFnTable(a_b_ns');
    expect(content).toContain('const a_b_2_fns = buildFnTable(a_b_2_ns');
    expect(content).toContain('import * as a_b_2_ns from');
    expect(syntacticErrors(content)).toEqual([]);
  });

  it('969e36f4 AC3 (characterization): a non-hyphenated id "myPkg" yields index.ts byte-identical to the pre-change template', () => {
    const content = indexContentFor([{ id: 'myPkg', importPath: '@acme/my-pkg' }], false);
    const expected = [
      '// Auto-generated by @adhd/apigen-cli — do not edit',
      "import { buildFnTable } from '@adhd/apigen-engine-runtime'",
      "import * as myPkg_ns from '@acme/my-pkg'",
      'const myPkg_fns = buildFnTable(myPkg_ns as Record<string, unknown>)',
      '',
      'export const toolMetas: Record<string, { group: string; fnName: string; schema: unknown; description: string }> = {',
      '}',
      '',
      'export const groupFns: Record<string, Record<string, (...args: unknown[]) => unknown>> = {',
      "  'myPkg': myPkg_fns as Record<string, (...args: unknown[]) => unknown>,",
      '}',
      '',
      'export const groupCreateClient: Record<string, ((e: Record<string, unknown>) => Promise<unknown>) | undefined> = {',
      "  'myPkg': undefined, // injected at startup if createClient provided",
      '}',
    ].join('\n');
    expect(content).toBe(expected);
  });

  it('969e36f4: an id and importPath containing a quote and a backslash yield index.ts that parses, with the literal escaped', () => {
    const content = indexContentFor([{ id: "a'b\\c", importPath: "@x/it's\\here" }]);
    expect(syntacticErrors(content)).toEqual([]);
    expect(content).toContain("'a\\'b\\\\c': ");
    expect(content).toContain("from '@x/it\\'s\\\\here'");
    expect(content).toContain("group: 'a\\'b\\\\c'");
  });

  it('969e36f4: an id with newline, carriage return, U+2028 and U+2029 yields parseable index.ts with no raw terminators', () => {
    const content = indexContentFor([
      { id: 'a\nb\rc\u2028d\u2029e', importPath: '@x/line\nbreak' },
    ]);
    expect(syntacticErrors(content)).toEqual([]);
    expect(content).not.toMatch(/[\u2028\u2029\r]/);
  });

  it('969e36f4: duplicate raw package ids throw an Error naming the id and emit nothing', () => {
    const input: PluginInput = {
      packages: [
        { id: 'dup-pkg', importPath: '@x/one', schemas: {}, fns: {} },
        { id: 'other', importPath: '@x/two', schemas: {}, fns: {} },
        { id: 'dup-pkg', importPath: '@x/three', schemas: {}, fns: {} },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    let produced: unknown;
    expect(() => {
      produced = generate(input);
    }).toThrow(/duplicate package id.*"dup-pkg"/);
    expect(produced).toBeUndefined();
  });
});
