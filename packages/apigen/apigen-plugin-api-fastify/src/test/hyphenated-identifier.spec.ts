/**
 * Regression test for BUG-APIGEN-032 (entrypoint/apigen-cli/BACKLOG.md): the
 * api-fastify generator spliced a discovered package id straight into JS
 * identifier positions (`import * as ${pkg.id}_ns from …`,
 * `const ${pkg.id}_fns = …`, and the `dispatch(${pkg.id}_fns …)` call
 * sites) with no sanitization. Any hyphenated package id — the repo
 * convention, and the overwhelmingly common case in real Nx workspaces
 * (`pkg-a`, `@scope/some-package-name`, …) — produced genuinely invalid
 * TypeScript/JavaScript (`import * as pkg-a_ns from …`; a bare `-` is the
 * subtraction operator in an identifier position, not a valid character).
 *
 * Two layers of proof, mirroring apigen-plugin-cli-output's regression test
 * for the same bug class (BUG-APIGEN-CLI-001):
 *   (1) Unit check — generate() with a hyphenated `id` never emits the raw
 *       invalid identifier form, emits the sanitized one at every splice
 *       site instead, and keeps the id verbatim in the schema-key STRING.
 *   (2) Real syntax check via esbuild — the OLD unsanitized splice pattern
 *       is proven to be a genuine parse error (not just a lint nit), and the
 *       CURRENT generate() output is proven to parse/transpile cleanly.
 */
import { describe, it, expect } from 'vitest';
import * as esbuild from 'esbuild';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

function makePingSchema() {
  return {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {} } },
      required: ['data'],
    },
    output: { type: 'object', properties: { ok: { type: 'boolean' } } },
  };
}

const hyphenatedInput: PluginInput = {
  packages: [
    {
      id: 'pkg-a',
      importPath: '@test/pkg-a',
      schemas: { ping: makePingSchema() },
      fns: { ping: () => ({ ok: true }) },
    },
  ],
  outputDir: '/tmp/out',
  options: {},
};

describe('generate() — hyphenated package id sanitization (unit)', () => {
  it('[hyphen-fastify.1] sanitizes the import-namespace and fn-table identifiers', () => {
    const { content } = generate(hyphenatedInput).files[0];

    expect(content).not.toContain('import * as pkg-a_ns');
    expect(content).not.toContain('pkg-a_fns');

    expect(content).toContain("import * as pkg_a_ns from '@test/pkg-a'");
    expect(content).toContain('const pkg_a_fns = buildFnTable(pkg_a_ns');
  });

  it('[hyphen-fastify.2] sanitizes the identifier at both GET and POST dispatch call sites', () => {
    const safeSchema = { ping: { ...makePingSchema(), 'x-apigen-safe': true } };
    const safeInput: PluginInput = {
      packages: [
        {
          id: 'pkg-a',
          importPath: '@test/pkg-a',
          schemas: safeSchema,
          fns: { ping: () => ({ ok: true }) },
        },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    const { content: getContent } = generate(safeInput).files[0];
    expect(getContent).toContain('dispatch(pkg_a_fns as any');
    expect(getContent).not.toContain('dispatch(pkg-a_fns');

    const { content: postContent } = generate(hyphenatedInput).files[0];
    expect(postContent).toContain('dispatch(pkg_a_fns as any');
    expect(postContent).not.toContain('dispatch(pkg-a_fns');
  });

  it('[hyphen-fastify.3] the raw hyphenated id is preserved verbatim as a schema-key STRING', () => {
    const { content } = generate(hyphenatedInput).files[0];
    expect(content).toContain('"pkg-a:ping"');
    expect(content).toContain("schemas['pkg-a:ping']");
  });

  it('[hyphen-fastify.4] is a no-op for an already-valid identifier', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'myPkg',
          importPath: '@acme/my-pkg',
          schemas: { ping: makePingSchema() },
          fns: { ping: () => ({ ok: true }) },
        },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    const { content } = generate(input).files[0];
    expect(content).toContain("import * as myPkg_ns from '@acme/my-pkg'");
    expect(content).toContain('const myPkg_fns = buildFnTable(myPkg_ns');
  });
});

describe('generate() — REAL syntax verification via esbuild', () => {
  it('[hyphen-fastify.5] proves the OLD unsanitized splice was a genuine parse error', () => {
    // Exact pre-fix shape: `import * as ${pkg.id}_ns from '...'`.
    const brokenSnippet = `import * as pkg-a_ns from '@test/pkg-a'\nconst pkg-a_fns = 1\n`;
    expect(() =>
      esbuild.transformSync(brokenSnippet, { loader: 'ts' })
    ).toThrow();
  });

  it('[hyphen-fastify.6] the current generate() output parses and transpiles cleanly', () => {
    const { content } = generate(hyphenatedInput).files[0];
    expect(() =>
      esbuild.transformSync(content, { loader: 'ts' })
    ).not.toThrow();
  });
});
