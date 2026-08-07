// root-oneof-branch.spec.ts — BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001.
//
// Coverage:
//   - `resolveRootUnion` (schema-introspect.ts): detects a root-level
//     `oneOf`+`discriminator` domain schema and decomposes it into per-branch
//     flag data, using the REAL shape `@adhd/apigen-core-client`'s
//     `buildBatchMountedOperations` (the actual, shipped `apigen-plugin-batch`
//     mount derivation) produces — not an invented-in-isolation fixture.
//   - `generate()`: renders N Commander subcommands (one per discriminator
//     branch) instead of zero flags; a flat (non-union) operation's emitted
//     source is completely unaffected (regression guard).
//   - Real end-to-end proof: the generated `cli.ts` source is written to
//     disk next to a real target module and driven as a REAL spawned `node`
//     child process (real argv parsing, real dispatch, real function call) —
//     not an in-process shortcut.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Descriptor,
  Operation,
  PluginInput,
} from '@adhd/apigen-core-client';
import { buildBatchMountedOperations } from '@adhd/apigen-core-client';
import { generate } from '../lib/generate';
import { resolveRootUnion, dataSchemaProps } from '../lib/schema-introspect';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Real-shape fixture — builds an actual `_batch/<kind>` mount schema via the
// REAL, shipped `apigen-core-client` batch derivation (not a hand-invented
// oneOf shape), mirroring `apigen-core-client/src/test/batch.spec.ts`'s own
// fixture helpers.
// ---------------------------------------------------------------------------

function seg(raw: string) {
  return { raw, words: [raw.toLowerCase()] };
}

function op(id: string, input: Record<string, unknown>): Operation {
  const [namespace, ...restPath] = id.split('/');
  return {
    id,
    host: 'ts',
    namespace: seg(namespace),
    path: restPath.length > 0 ? restPath.map(seg) : [seg(id)],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input,
    output: { type: 'object' },
    envelope: {},
    typeText: null,
  };
}

/** Builds a real root-level `oneOf`+`discriminator` domain schema from the ACTUAL batch plugin machinery. */
function realBatchDomainSchema(): Record<string, unknown> {
  const ops: Operation[] = [
    op('createItem', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }),
    op('sendTask', {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    }),
  ];
  const descriptor: Descriptor = { host: 'ts', operations: ops };
  const [mounted] = buildBatchMountedOperations(descriptor, {});
  expect(mounted).toBeDefined();
  // `buildBatchMountedOperations`'s `.input` IS the real root-level
  // `oneOf`+`discriminator` schema (`buildBatchKindSchema`'s output) — the
  // exact shape this bug is about, verbatim from production code.
  return mounted.input as Record<string, unknown>;
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
// resolveRootUnion — unit coverage
// ---------------------------------------------------------------------------

describe('resolveRootUnion', () => {
  it('returns undefined for a flat {type:"object", properties:{...}} domain schema (no false positive)', () => {
    const flatSchema = {
      input: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
        required: ['data'],
      },
      output: { type: 'object' },
    };
    expect(resolveRootUnion(flatSchema)).toBeUndefined();
    // The existing flat helper still finds the property (untouched).
    expect(dataSchemaProps(flatSchema).props).toHaveProperty('id');
  });

  it('detects the REAL batch mount root-level oneOf+discriminator domain schema', () => {
    const domainSchema = realBatchDomainSchema();
    const schema = {
      input: {
        type: 'object',
        properties: { data: domainSchema },
        required: ['data'],
      },
      output: { type: 'object' },
    };

    const result = resolveRootUnion(schema);
    expect(result).toBeDefined();
    expect(result?.discriminatorProperty).toBe('operation');
    expect(result?.branches).toHaveLength(2);

    const values = result?.branches.map((b) => b.value).sort();
    expect(values).toEqual(['createItem', 'sendTask']);

    const createBranch = result?.branches.find((b) => b.value === 'createItem');
    expect(createBranch?.commandName).toBe('create-item');
    // Each branch's own properties are flat — `items`/`operation` present,
    // per `branchInputSchema` — proving "once inside a branch it's flat again".
    expect(createBranch?.props).toHaveProperty('items');
    expect(createBranch?.props).toHaveProperty('operation');
    expect(createBranch?.required).toContain('items');
  });

  it('the PRE-FIX symptom: dataSchemaProps/dataParamNames-equivalent flat access finds ZERO properties for the same schema (regression evidence)', () => {
    const domainSchema = realBatchDomainSchema();
    const schema = {
      input: {
        type: 'object',
        properties: { data: domainSchema },
        required: ['data'],
      },
      output: { type: 'object' },
    };
    // This is exactly the bug: the flat accessor sees no top-level
    // `properties` on a oneOf-shaped domain schema.
    expect(dataSchemaProps(schema).props).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// generate() — codegen coverage
// ---------------------------------------------------------------------------

describe('generate() — root-level oneOf+discriminator operation', () => {
  function makeBatchInput(): PluginInput {
    const domainSchema = realBatchDomainSchema();
    return makeInput({
      packages: [
        {
          id: 'svc',
          importPath: './target',
          schemas: {
            batchAction: {
              input: {
                type: 'object',
                properties: { data: domainSchema },
                required: ['data'],
              },
              output: {},
            },
          },
        },
      ],
    });
  }

  it('emits one Commander subcommand per discriminator branch, not zero flags', () => {
    const { content } = generate(makeBatchInput()).files[0];

    // Parent command grouping the branches.
    expect(content).toMatch(/program\.command\('batchAction'\)/);
    // One subcommand per branch.
    expect(content).toContain(".command('create-item')");
    expect(content).toContain(".command('send-task')");
    // Each branch's own flat properties render as real flags (the bug: this
    // used to be nothing at all for the whole operation).
    expect(content).toContain(".requiredOption('--items <items>')");
  });

  it('does NOT expose the discriminator field ("operation") itself as a CLI flag — it is implied by the subcommand', () => {
    const { content } = generate(makeBatchInput()).files[0];
    expect(content).not.toMatch(/--operation\b/);
  });

  it('binds the discriminator literal value into domainArgs for each branch', () => {
    const { content } = generate(makeBatchInput()).files[0];
    expect(content).toContain(`'operation': "createItem"`);
    expect(content).toContain(`'operation': "sendTask"`);
  });

  it('the JSON-parse helper is emitted because a branch has a JSON-typed ("items"-equivalent array) param', () => {
    const { content } = generate(makeBatchInput()).files[0];
    expect(content).toMatch(/function __apigenParseJsonArg/);
  });

  it('registers a synthesized flat per-branch dispatch schema so dispatch()/dataParamNames resolve args unmodified', () => {
    const { content } = generate(makeBatchInput()).files[0];
    expect(content).toContain(`"svc:batchAction::create-item"`);
    expect(content).toContain(`"svc:batchAction::send-task"`);
  });

  // ---------------------------------------------------------------------
  // Regression guard — the existing flat-schema path is byte-for-byte
  // unaffected by this change (AGENTS.md constraint: no behavior change for
  // any existing flat operation).
  // ---------------------------------------------------------------------
  it('a flat (non-union) operation is completely unaffected — still one .command(fnName) with flags directly on it', () => {
    const input = makeInput({
      packages: [
        {
          id: 'myPkg',
          importPath: '@acme/my-pkg',
          schemas: {
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
          },
        },
      ],
    });
    const { content } = generate(input).files[0];
    expect(content).toContain(".command('getUser')");
    expect(content).toContain(".requiredOption('--user-id <user-id>')");
    expect(content).not.toContain('_cmd');
    expect(content).not.toContain('::');
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end proof — the generated source is written to disk and driven
// as a REAL spawned `node` child process against a real target module (per
// AGENTS.md §7: real components, real dispatch, no in-process shortcut).
// ---------------------------------------------------------------------------

describe('[root-oneof.e2e] real spawned process — the batch-shaped subcommands are genuinely invokable', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeFixture(): { cliPath: string; targetPath: string } {
    // Ephemeral test output lives under this package's own `tmp/` (AGENTS.md
    // §10) — nested here (rather than the OS temp dir) so Node module
    // resolution walking up the directory tree finds this package's own
    // `node_modules/@adhd/*` workspace symlinks (apigen-engine-runtime).
    const base = path.join(__dirname, '..', '..', 'tmp', 'root-oneof-e2e');
    fs.mkdirSync(base, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(base, 'run-'));

    const domainSchema = realBatchDomainSchema();
    const pluginInput: PluginInput = {
      packages: [
        {
          id: 'svc',
          importPath: './target',
          schemas: {
            batchAction: {
              input: {
                type: 'object',
                properties: { data: domainSchema },
                required: ['data'],
              },
              output: {},
            },
          },
        },
      ],
      outputDir: tmpDir,
      options: {},
    };
    const { content } = generate(pluginInput).files[0];

    const cliPath = path.join(tmpDir, 'cli.ts');
    fs.writeFileSync(cliPath, content);

    // Real target module — a normal exported TS function, positionally
    // receiving (operation, items, concurrency, mode, onItemError,
    // itemTimeoutMs) in the SAME order `branchInputSchema` declares them
    // (JS object key insertion order), matching what the synthesized
    // per-branch dispatch schema (`dataParamNames`) resolves.
    const targetPath = path.join(tmpDir, 'target.ts');
    fs.writeFileSync(
      targetPath,
      [
        `export function batchAction(`,
        `  operation: string,`,
        `  items: unknown[],`,
        `  concurrency?: number,`,
        `  mode?: string,`,
        `  onItemError?: string,`,
        `  itemTimeoutMs?: number`,
        `) {`,
        `  return { operation, items, concurrency, mode, onItemError, itemTimeoutMs };`,
        `}`,
      ].join('\n')
    );

    return { cliPath, targetPath };
  }

  it(
    'real subprocess: "svc batchAction create-item --items \'[...]\'" dispatches the real function with the real branch args',
    { timeout: 30000 },
    async () => {
      const { cliPath } = writeFixture();

      const { stdout, stderr } = await execFileAsync(
        'node',
        [
          '-r',
          '@swc-node/register',
          cliPath,
          'batchAction',
          'create-item',
          '--items',
          '[{"name":"widget"}]',
        ],
        {
          env: {
            ...process.env,
            NODE_PATH: [
              path.join(__dirname, '..', '..', 'node_modules'),
              path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules'),
            ].join(path.delimiter),
          },
        }
      );

      expect(stderr).toBe('');
      const result = JSON.parse(stdout.trim().split('\n').pop() as string);
      expect(result).toEqual({
        operation: 'createItem',
        items: [{ name: 'widget' }],
      });
    }
  );

  it(
    'real subprocess: the OTHER branch ("send-task") is a genuinely distinct, dispatchable subcommand',
    { timeout: 30000 },
    async () => {
      const { cliPath } = writeFixture();

      const { stdout, stderr } = await execFileAsync(
        'node',
        [
          '-r',
          '@swc-node/register',
          cliPath,
          'batchAction',
          'send-task',
          '--items',
          '[{"taskId":"t-1"}]',
          '--concurrency',
          '2',
        ],
        {
          env: {
            ...process.env,
            NODE_PATH: [
              path.join(__dirname, '..', '..', 'node_modules'),
              path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules'),
            ].join(path.delimiter),
          },
        }
      );

      expect(stderr).toBe('');
      const result = JSON.parse(stdout.trim().split('\n').pop() as string);
      expect(result).toEqual({
        operation: 'sendTask',
        items: [{ taskId: 't-1' }],
        concurrency: 2,
      });
    }
  );

  it(
    '[negative control] pre-fix behavior reproduced: a bare flat-schema reading of the same real batch domain schema yields zero usable flags',
    () => {
      // This is the literal bug this backlog item fixes — proven directly
      // against the SAME real schema used above, via the OLD flat-only
      // accessor, with no subcommand fallback.
      const domainSchema = realBatchDomainSchema();
      const flatOnly = dataSchemaProps({
        input: {
          type: 'object',
          properties: { data: domainSchema },
          required: ['data'],
        },
        output: {},
      });
      expect(Object.keys(flatOnly.props)).toEqual([]);
      expect(flatOnly.required).toEqual([]);
    }
  );
});
