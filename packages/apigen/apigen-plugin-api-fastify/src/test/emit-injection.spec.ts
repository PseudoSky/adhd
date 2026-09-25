/**
 * Codegen injection hardening (ff1b22ad) — emitted-source parse proof.
 *
 * Every dynamic value the Fastify generator splices into `routes.ts` must be
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
    output: { type: 'object', properties: { ok: { type: 'boolean' } } },
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

  it('[inject-fastify.1] adversarial ids/routes/headers/fn-names yield parseable TypeScript', () => {
    expect(() =>
      esbuild.transformSync(content(), { loader: 'ts' })
    ).not.toThrow();
  });

  it('[inject-fastify.2] no raw single-quoted dynamic splice survives', () => {
    const c = content();
    expect(c).not.toContain("schemas['"); // schema-key access
    expect(c).not.toContain("from 'pkg"); // dynamic import specifier
    expect(c).not.toContain("app.get('"); // GET route literal
    expect(c).not.toContain("app.post('"); // POST route literal
  });

  it('[inject-fastify.3] U+2028/U+2029 never reach the emitted source raw', () => {
    const c = content();
    expect(c).not.toContain('\u2028');
    expect(c).not.toContain('\u2029');
  });

  it('[inject-fastify.4] the escaped forms are present, not merely absent', () => {
    const c = content();
    expect(c).toContain('schemas["pk\'g:'); // escaped schema key
    expect(c).toContain('from "pkg\\\\path\'x"'); // escaped import specifier
    expect(c).toContain('"fn\'safe"'); // escaped fn name (dispatch arg)
    expect(c).toContain('"fn\\"unsafe"'); // escaped double-quote fn name
    expect(c).toContain('"fn\\nline"'); // escaped newline fn name
    expect(c).toContain('"ses\'sion"'); // escaped envelope field key
    expect(c).toContain('"x-adhd-ses\'sion"'); // escaped envelope header value
  });

  it('[inject-fastify.5] negative control — the raw splices are genuine parse errors', () => {
    // A raw single-quoted schema-key splice.
    const rawKey = `const schemas: Record<string, unknown> = {}\nconst k = schemas['pk'g:x']['schema']\n`;
    expect(() => esbuild.transformSync(rawKey, { loader: 'ts' })).toThrow();

    // A raw newline inside a single-quoted literal.
    const rawNewline = `const x = 'fn\nline'\n`;
    expect(() => esbuild.transformSync(rawNewline, { loader: 'ts' })).toThrow();

    // A raw apostrophe in a single-quoted import specifier.
    const rawImport = `import * as a from 'pkg\\path'x'\n`;
    expect(() => esbuild.transformSync(rawImport, { loader: 'ts' })).toThrow();
  });
});

describe('generate() — generated host lifecycle (b7bb606d)', () => {
  it('[lifecycle-fastify.1] installs a fallback error handler and awaits listen in main(), exiting non-zero on failure', () => {
    const c = generate(adversarialInput()).files[0].content;
    expect(c).toContain('app.setErrorHandler(');
    expect(c).toContain('async function main()');
    expect(c).toContain('await app.listen(');
    expect(c).toContain('process.exit(1)');
    expect(c).toContain('main()');
  });

  it('[lifecycle-fastify.2] negative control — no bare floating app.listen remains', () => {
    const c = generate(adversarialInput()).files[0].content;
    // The old shape was a top-level bare call; the new one is `await`ed inside
    // `main()`, so no line starts with `app.listen(`.
    expect(c).not.toMatch(/^app\.listen\(/m);
  });
});
