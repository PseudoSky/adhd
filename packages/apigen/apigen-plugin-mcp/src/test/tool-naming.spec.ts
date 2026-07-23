import { describe, it, expect } from 'vitest';
import { deriveToolName, findOperation } from '../lib/tool-naming';
import { project } from '@adhd/apigen-engine-naming';
import type { Operation, Segment } from '@adhd/apigen-core-client';

// ---------- fixtures ----------

const namespaceSeg: Segment = { raw: 'billing', words: ['billing'] };
const fileSeg: Segment = { raw: 'invoiceApi', words: ['invoice', 'api'] };

function makeOp(exportName: string, exportWords: string[]): Operation {
  return {
    id: `billing/invoice-api/${exportName}`,
    host: 'ts',
    namespace: namespaceSeg,
    path: [fileSeg, { raw: exportName, words: exportWords }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}

const getInvoiceOp = makeOp('getInvoice', ['get', 'invoice']);
const voidInvoiceOp = makeOp('voidInvoice', ['void', 'invoice']);
const operations: Operation[] = [getInvoiceOp, voidInvoiceOp];

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] findOperation()', () => {
  it('finds the exact Operation by (namespace, terminal path segment)', () => {
    const found = findOperation(operations, 'billing', 'getInvoice');
    expect(found).toBe(getInvoiceOp);
  });

  it('returns undefined for an unknown fnName', () => {
    expect(findOperation(operations, 'billing', 'doesNotExist')).toBeUndefined();
  });

  it('returns undefined for an unknown namespace', () => {
    expect(findOperation(operations, 'other-ns', 'getInvoice')).toBeUndefined();
  });

  it('returns undefined when operations is absent', () => {
    expect(findOperation(undefined, 'billing', 'getInvoice')).toBeUndefined();
  });

  it('ignores non-"action" kind operations (MCP only ever serves actions)', () => {
    const queryOp: Operation = { ...getInvoiceOp, kind: 'query', safe: true };
    expect(findOperation([queryOp], 'billing', 'getInvoice')).toBeUndefined();
  });
});

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] deriveToolName() — exact path (operations supplied)', () => {
  it('equals project(op).mcp.name for the real correlated Operation', () => {
    const name = deriveToolName(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    expect(name).toBe(project(getInvoiceOp).mcp.name);
    expect(name).toBe('billing_invoice_api_get_invoice');
  });

  it('is correct for every op in a representative multi-op set', () => {
    for (const op of operations) {
      const fnName = op.path[op.path.length - 1].raw;
      const name = deriveToolName(
        { id: 'billing', importPath: '@acme/billing' },
        fnName,
        operations
      );
      expect(name).toBe(project(op).mcp.name);
    }
  });

  it('[negative control] the canonical name differs from the OLD raw fn name', () => {
    const name = deriveToolName(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    // Proves this is a genuine rename: a parity assertion of
    // `name === 'getInvoice'` (the OLD, pre-fix behavior) would fail here.
    expect(name).not.toBe('getInvoice');
  });

  it('throws when operations is supplied but no Operation correlates (invariant violation — fails loud, never silently guesses)', () => {
    expect(() =>
      deriveToolName(
        { id: 'billing', importPath: '@acme/billing' },
        'doesNotExist',
        operations
      )
    ).toThrow(/no Operation found/);
  });
});

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] deriveToolName() — best-effort fallback (generate(), no operations)', () => {
  it('derives a deterministic snake_case name from (pkg.id, importPath, fnName) via project()', () => {
    const name = deriveToolName(
      { id: 'billing', importPath: '/src/invoice-api.ts' },
      'getInvoice'
    );
    // namespace='billing' -> ['billing']; file='invoice-api' -> ['invoice','api'];
    // export='getInvoice' -> ['get','invoice'].
    expect(name).toBe('billing_invoice_api_get_invoice');
  });

  it('reproduces the EXACT-path name when importPath is the real physical source file', () => {
    // Same namespace + fn, but this time correlated via the fallback (no
    // operations) using an importPath whose basename matches the real
    // extracted fileSeg ('invoiceApi' / 'invoice-api' tokenize identically).
    const fallbackName = deriveToolName(
      { id: 'billing', importPath: '/repo/src/invoice-api.ts' },
      'getInvoice'
    );
    const exactName = deriveToolName(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    expect(fallbackName).toBe(exactName);
  });

  it('is deterministic and collision-resistant across two different fns in the same package', () => {
    const a = deriveToolName({ id: 'billing', importPath: '/src/api.ts' }, 'getInvoice');
    const b = deriveToolName({ id: 'billing', importPath: '/src/api.ts' }, 'voidInvoice');
    expect(a).not.toBe(b);
  });
});
