import { describe, it, expect } from 'vitest';
import { operationFor } from '../lib/tool-naming';
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

describe('[mcp-adapter.3] operationFor() — exact path (operations supplied)', () => {
  it('finds the exact Operation by (namespace, terminal path segment)', () => {
    const found = operationFor(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    expect(found).toBe(getInvoiceOp);
  });

  it('is correct for every op in a representative multi-op set', () => {
    for (const op of operations) {
      const fnName = op.path[op.path.length - 1].raw;
      const found = operationFor(
        { id: 'billing', importPath: '@acme/billing' },
        fnName,
        operations
      );
      expect(found).toBe(op);
    }
  });

  it('ignores non-"action" kind operations (MCP only ever serves actions)', () => {
    const queryOp: Operation = { ...getInvoiceOp, kind: 'query', safe: true };
    expect(() =>
      operationFor({ id: 'billing', importPath: '@acme/billing' }, 'getInvoice', [
        queryOp,
      ])
    ).toThrow(/no Operation found/);
  });

  it('throws when operations is supplied but no Operation correlates (invariant violation — fails loud, never silently guesses)', () => {
    expect(() =>
      operationFor(
        { id: 'billing', importPath: '@acme/billing' },
        'doesNotExist',
        operations
      )
    ).toThrow(/no Operation found/);
  });

  it('throws for an unknown namespace', () => {
    expect(() =>
      operationFor({ id: 'other-ns', importPath: '@acme/other' }, 'getInvoice', operations)
    ).toThrow(/no Operation found/);
  });
});

describe('[mcp-adapter.3] operationFor() → project().mcp.name — the collapsed naming path', () => {
  it('project(operationFor(...)).mcp.name equals project(op).mcp.name for the real correlated Operation', () => {
    const found = operationFor(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    expect(project(found).mcp.name).toBe(project(getInvoiceOp).mcp.name);
    expect(project(found).mcp.name).toBe('billing_invoice_api_get_invoice');
  });

  it('[negative control] the canonical name differs from the OLD raw fn name', () => {
    const found = operationFor(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    // Proves this is a genuine rename: a parity assertion of
    // `name === 'getInvoice'` (the OLD, pre-fix behavior) would fail here.
    expect(project(found).mcp.name).not.toBe('getInvoice');
  });
});

describe('[mcp-adapter.3] operationFor() — best-effort fallback (generate(), no operations)', () => {
  it('derives a deterministic snake_case name from (pkg.id, importPath, fnName) via project()', () => {
    const found = operationFor(
      { id: 'billing', importPath: '/src/invoice-api.ts' },
      'getInvoice'
    );
    // namespace='billing' -> ['billing']; file='invoice-api' -> ['invoice','api'];
    // export='getInvoice' -> ['get','invoice'].
    expect(project(found).mcp.name).toBe('billing_invoice_api_get_invoice');
  });

  it('reproduces the EXACT-path name when importPath is the real physical source file', () => {
    // Same namespace + fn, but this time correlated via the fallback (no
    // operations) using an importPath whose basename matches the real
    // extracted fileSeg ('invoiceApi' / 'invoice-api' tokenize identically).
    const fallback = operationFor(
      { id: 'billing', importPath: '/repo/src/invoice-api.ts' },
      'getInvoice'
    );
    const exact = operationFor(
      { id: 'billing', importPath: '@acme/billing' },
      'getInvoice',
      operations
    );
    expect(project(fallback).mcp.name).toBe(project(exact).mcp.name);
  });

  it('is deterministic and collision-resistant across two different fns in the same package', () => {
    const a = operationFor({ id: 'billing', importPath: '/src/api.ts' }, 'getInvoice');
    const b = operationFor({ id: 'billing', importPath: '/src/api.ts' }, 'voidInvoice');
    expect(project(a).mcp.name).not.toBe(project(b).mcp.name);
  });
});
