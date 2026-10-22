/**
 * guards: `@adhd/policy` (or the two packages it bundles from source) is published as an ES module again - `"type": "module"` or an `exports` map in package.json, a vite library format other than cjs, or a built bin that uses ESM syntax - so a CommonJS consumer's require() of the shipped bin or library throws on load.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R11, §3 R11b-d; ADR-0003 D1/D2 (CommonJS only, no exports map). The load proof of the built bins is the `policy:verify-dist-load` target (recorded in the report).
 * red-run: 2026-10-21 control: `"type": "module"` added to entrypoint/policy/package.json -> 1 failed; vite `formats: ['es']` -> 1 failed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../../../..');

/** Package roots: the entrypoint and the two library packages R11b/R11c converted. */
const PACKAGES = [
  { name: '@adhd/policy', root: 'entrypoint/policy' },
  { name: '@adhd/apigen-plugin-policy', root: 'packages/apigen/apigen-plugin-policy' },
  { name: '@adhd/policy-core-client', root: 'packages/policy/policy-core-client' },
] as const;

describe('CommonJS only (T-R11)', () => {
  for (const pkg of PACKAGES) {
    describe(pkg.name, () => {
      const manifest = JSON.parse(readFileSync(join(REPO, pkg.root, 'package.json'), 'utf8')) as Record<string, unknown>;

      it('package.json is the package it claims to be, and has no "type": "module", no "module" field and no exports map', () => {
        expect(manifest['name']).toBe(pkg.name);
        expect(manifest['type']).not.toBe('module');
        expect(manifest).not.toHaveProperty('exports');
        expect(manifest).not.toHaveProperty('module');
      });

      it('the vite library build emits cjs only (and the config is a .ts file, not .mts)', () => {
        const config = readFileSync(join(REPO, pkg.root, 'vite.config.ts'), 'utf8');
        const formats = /formats:\s*\[([^\]]*)\]/.exec(config);
        expect(formats, 'formats: [...] is declared').not.toBeNull();
        const listed = (formats?.[1] ?? '').split(',').map((item) => item.replace(/['"\s]|as const/g, '')).filter(Boolean);
        expect(listed).toEqual(['cjs']);
      });
    });
  }

  it('the policy bins are published as executables pointing at dist/*.js', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'entrypoint/policy/package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(manifest.bin).toEqual({
      'adhd-policy': './dist/cli.js',
      'adhd-policy-mcp': './dist/mcp.js',
      'adhd-policy-http': './dist/http.js',
    });
  });

  it('the built bundle in dist/ is CommonJS: require()-based, compiles under the CommonJS wrapper', () => {
    const dist = join(REPO, 'entrypoint/policy/dist');
    const files = readdirSync(dist).filter((name) => name.endsWith('.js'));
    expect(files).toEqual(expect.arrayContaining(['cli.js', 'mcp.js', 'http.js']));
    for (const name of files) {
      const text = readFileSync(join(dist, name), 'utf8');
      // Compiled the way require() compiles a .js file (inside the CommonJS wrapper, not run): a top-level import/export is a SyntaxError.
      expect(() => new Script(Module.wrap(text.replace(/^#!.*\n/, '')), { filename: name }), `${name} compiles as CommonJS`).not.toThrow();
    }
    expect(readFileSync(join(dist, 'cli.js'), 'utf8')).toContain('require(');
  });
});
