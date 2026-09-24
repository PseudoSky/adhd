// root-oneof-branch.spec.ts — BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001
// (default lane — in-process, no subprocess).
//
// Coverage:
//   - `resolveRootUnion` (schema-introspect.ts): detects a root-level
//     `oneOf`+`discriminator` domain schema and decomposes it into per-branch
//     flag data.
//   - `generate()`: renders N Commander subcommands (one per discriminator
//     branch) instead of zero flags; a flat (non-union) operation's emitted
//     source is completely unaffected (regression guard).
//
// The real end-to-end proof — the generated `cli.ts` written to disk next to a
// real target module and driven as a REAL spawned `node` child process — lives
// in the sibling `root-oneof-branch.e2e.ts` (resource-consuming lane; see its
// header). It was extracted out of this default target so `nx affected -t test`
// / the pre-commit + pre-push hooks never spawn a process for it; the shared
// fixture both lanes import lives in `./fixtures/root-oneof-branch.fixture.ts`.

import { describe, it, expect } from 'vitest';
import type { PluginInput } from '@adhd/apigen-core-client';
import { generate } from '../lib/generate';
import { resolveRootUnion, dataSchemaProps } from '../lib/schema-introspect';
import { realBatchDomainSchema } from './fixtures/root-oneof-branch.fixture';

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
