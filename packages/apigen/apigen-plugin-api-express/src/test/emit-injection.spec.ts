/**
 * Codegen injection hardening (61ecfab8) — emitted-source parse proof.
 *
 * Every dynamic value the Express generator splices into `routes.ts` must be
 * escaped at its splice site (identifiers via `sanitizeIdentifier`, string
 * literals via `escapeStringLiteral`). These tests drive `generate()` with
 * adversarial package ids / import paths / fn names / envelope fields / route
 * prefixes — each carrying a quote, backslash, newline or Unicode line
 * separator — and assert the CONSUMER-VISIBLE outcome: the emitted file parses
 * as real TypeScript via esbuild, and no raw (unescaped) splice survives.
 */
import { describe, it, expect } from 'vitest';
import * as esbuild from 'esbuild';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

const PKG_ID = "pk'g"; // apostrophe in the package id
const IMPORT_PATH = "pkg\\path'x"; // backslash + apostrophe in the specifier
const ROUTE_PREFIX = "/pre'fix\\x\u2028y\u2029"; // quote + backslash + U+2028/9
const FN_APOSTROPHE = "fn'safe";
const FN_DQUOTE = 'fn"unsafe';
const FN_NEWLINE = 'fn\nline';
const ENVELOPE_FIELD = "ses'sion";

function schemaWith(
  properties: Record<string, unknown>,
  safe = false
): Record<string, unknown> {
  return {
    input: { type: 'object', properties, required: [] },
    // The output description carries U+2028/U+2029: `JSON.stringify` leaves
    // them raw in the emitted `schemas` blob, so this proves the blob is
    // post-processed by the same line-terminator escape as every other splice.
    output: {
      type: 'object',
      description: 'ok\u2028line\u2029end',
      properties: { ok: { type: 'boolean' } },
    },
    ...(safe ? { 'x-apigen-safe': true } : {}),
  };
}

// `data` is an object-typed property, so the op does NOT auto-hoist to GET by
// primitive-param shape (FEAT-APIGEN-022) — the POST branch is exercised.
const objectData = { data: { type: 'object', properties: {} } };

function adversarialInput(): PluginInput {
  return {
    packages: [
      {
        id: PKG_ID,
        importPath: IMPORT_PATH,
        schemas: {
          // safe → GET branch (also has an envelope field → header splice)
          [FN_APOSTROPHE]: schemaWith(
            { ...objectData, [ENVELOPE_FIELD]: { type: 'string' } },
            true
          ),
          [FN_DQUOTE]: schemaWith(objectData),
          [FN_NEWLINE]: schemaWith(objectData),
        },
        fns: {
          [FN_APOSTROPHE]: () => ({ ok: true }),
          [FN_DQUOTE]: () => ({ ok: true }),
          [FN_NEWLINE]: () => ({ ok: true }),
        },
      },
    ],
    outputDir: '/tmp/out',
    options: { routePrefix: ROUTE_PREFIX },
  };
}

describe('generate() — codegen injection hardening', () => {
  const content = (): string => generate(adversarialInput()).files[0].content;

  it('[inject-express.1] adversarial ids/routes/headers/fn-names yield parseable TypeScript', () => {
    expect(() =>
      esbuild.transformSync(content(), { loader: 'ts' })
    ).not.toThrow();
  });

  it('[inject-express.2] no raw single-quoted dynamic splice survives', () => {
    const c = content();
    expect(c).not.toContain("schemas['"); // schema-key access
    expect(c).not.toContain("from 'pkg"); // dynamic import specifier
    expect(c).not.toContain("router.get('"); // GET route literal
    expect(c).not.toContain("router.post('"); // POST route literal
  });

  it('[inject-express.3] U+2028/U+2029 never reach the emitted source raw', () => {
    const c = content();
    expect(c).not.toContain('\u2028');
    expect(c).not.toContain('\u2029');
  });

  it('[inject-express.4] the escaped forms are present, not merely absent', () => {
    const c = content();
    expect(c).toContain('schemas["pk\'g:'); // escaped schema key
    expect(c).toContain('from "pkg\\\\path\'x"'); // escaped import specifier
    expect(c).toContain('"fn\'safe"'); // escaped fn name (dispatch arg)
    expect(c).toContain('"fn\\"unsafe"'); // escaped double-quote fn name
    expect(c).toContain('"fn\\nline"'); // escaped newline fn name
    expect(c).toContain('"ses\'sion"'); // escaped envelope field key
    expect(c).toContain('"x-adhd-ses\'sion"'); // escaped envelope header value
    // The schemas JSON blob carries a U+2028-bearing description — it must be
    // escaped in place (`\u2028`), not emitted raw.
    expect(c).toContain('\\u2028');
    expect(c).toContain('\\u2029');
  });

  it('[inject-express.5] negative control — the raw splices are genuine parse errors', () => {
    const rawKey = `const schemas: Record<string, unknown> = {}\nconst k = schemas['pk'g:x']['schema']\n`;
    expect(() => esbuild.transformSync(rawKey, { loader: 'ts' })).toThrow();

    const rawNewline = `const x = 'fn\nline'\n`;
    expect(() => esbuild.transformSync(rawNewline, { loader: 'ts' })).toThrow();

    const rawImport = `import * as a from 'pkg\\path'x'\n`;
    expect(() => esbuild.transformSync(rawImport, { loader: 'ts' })).toThrow();
  });

  it('[inject-express.6] the schema blob is emitted compact (no pretty-print)', () => {
    const c = content();
    // `{` is immediately followed by the first key — no newline/indent.
    expect(c).toMatch(/const schemas: Record<string, unknown> = \{"pk'g:/);
  });
});

describe('generate() — sanitized-identifier collision (cd9a5d6c)', () => {
  // `a-b` and `a_b` are DISTINCT package ids that both sanitize to `a_b`. A
  // per-package `import * as ${id}_ns` / `const ${id}_fns` would then emit the
  // same binding twice — a hard `routes.ts` parse error. The generator must
  // disambiguate them deterministically (`a_b`, `a_b_2`).
  function collidingInput(): PluginInput {
    const pkg = (id: string, importPath: string) => ({
      id,
      importPath,
      schemas: { ping: schemaWith(objectData) },
      fns: { ping: () => ({ ok: true }) },
    });
    return {
      packages: [pkg('a-b', '@test/a-b'), pkg('a_b', '@test/a_b')],
      outputDir: '/tmp/out',
      options: {},
    };
  }

  it('[inject-express.collision.1] colliding sanitized ids get distinct bindings and parse', () => {
    const c = generate(collidingInput()).files[0].content;
    expect(c).toContain('import * as a_b_ns from "@test/a-b"');
    expect(c).toContain('import * as a_b_2_ns from "@test/a_b"');
    expect(c).toContain('const a_b_fns = buildFnTable(a_b_ns');
    expect(c).toContain('const a_b_2_fns = buildFnTable(a_b_2_ns');
    expect(() => esbuild.transformSync(c, { loader: 'ts' })).not.toThrow();
  });

  it('[inject-express.collision.2] negative control — the un-disambiguated output is a genuine parse error', () => {
    // The exact pre-fix shape for two colliding ids: a duplicated namespace
    // import AND a duplicated `const …_fns` declaration. esbuild (like the JS
    // parser) rejects the redeclared `const`.
    const dup =
      `import * as a_b_ns from "@test/a-b"\n` +
      `import * as a_b_ns from "@test/a_b"\n` +
      `const a_b_fns = buildFnTable(a_b_ns)\n` +
      `const a_b_fns = buildFnTable(a_b_ns)\n`;
    expect(() => esbuild.transformSync(dup, { loader: 'ts' })).toThrow();
  });
});
