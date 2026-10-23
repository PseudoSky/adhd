/**
 * guards: descriptor.schema.json drifts from the Operation type: a valid `binding` / `hasCtx` / `tool` operation is rejected, or an empty `binding` / mistyped `tool.description` is accepted
 * tier: S
 * cites: REMEDIATION-PLAN T-R1 DoD (descriptor.schema.json validates an operation carrying binding, tool, hasCtx and rejects binding: ""); F-4 backlog c5cf9472 (hasCtx); commit 16a2b4fd (tool.description / tool.outputSchema)
 * tags: contract
 * teeth: red: remove the `binding` property from descriptor.schema.json (guarded temporary edit, restored) and run `npx vitest run src/test/descriptor-schema.spec.ts` in packages/apigen/apigen-core-client -> exit 1; "rejects an empty binding" and "accepts an operation carrying binding" go red (recorded in the T-R1 evidence table)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(
  readFileSync(join(__dirname, '../../src/lib/descriptor.schema.json'), 'utf8')
) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function operation(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'notes/save',
    host: 'ts',
    namespace: { raw: 'notes', words: ['notes'] },
    path: [{ raw: 'save', words: ['save'] }],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
    ...extra,
  };
}

function errorsFor(op: Record<string, unknown>): string {
  validate(op);
  return JSON.stringify(validate.errors ?? []);
}

describe('descriptor.schema.json (T-R1)', () => {
  it('accepts a bare operation', () => {
    expect(validate(operation()), errorsFor(operation())).toBe(true);
  });

  it('accepts an operation carrying binding, hasCtx and a full tool block', () => {
    const op = operation({
      binding: 'mcp:notes',
      hasCtx: true,
      tool: {
        title: 'Save note',
        description: 'Saves a note',
        annotations: { readOnlyHint: false },
        outputSchema: { type: 'object' },
      },
    });
    expect(validate(op), errorsFor(op)).toBe(true);
  });

  it('rejects an empty binding', () => {
    const op = operation({ binding: '' });
    expect(validate(op)).toBe(false);
    expect(errorsFor(op)).toContain('binding');
  });

  it('rejects a non-boolean hasCtx', () => {
    const op = operation({ hasCtx: 'yes' });
    expect(validate(op)).toBe(false);
    expect(errorsFor(op)).toContain('hasCtx');
  });

  it('rejects a numeric tool.description and a non-object tool.outputSchema', () => {
    const description = operation({ tool: { description: 7 } });
    expect(validate(description)).toBe(false);
    expect(errorsFor(description)).toContain('description');
    const output = operation({ tool: { outputSchema: 'object' } });
    expect(validate(output)).toBe(false);
    expect(errorsFor(output)).toContain('outputSchema');
  });
});
