/**
 * server.tracing-required.spec.ts — FEAT-APIGEN-TRACING required-consumer guard.
 *
 * `@adhd/backlog` is a REQUIRED consumer of `@adhd/apigen-plugin-tracing`: the
 * plugin is a declared dependency, a static ESM import in BOTH mount sources,
 * and an unconditional member of all THREE `usePlugins` arrays (the fastify
 * mount, the MCP mount, and the shared CLI `USE_PLUGINS`). None of that is a
 * flag — the point of this suite is that removing any one of the four is a
 * hard, mechanical failure, not a silent gap:
 *
 *   1. drop the package / dep entry   → `pnpm install --frozen-lockfile` fails
 *      (ERR_PNPM_OUTDATED_LOCKFILE) and, on a stale install, `nx build backlog`
 *      fails resolution (`TS2307` in server.ts/cli.ts, then a vite/rollup
 *      "failed to resolve import" error).
 *   2. drop an array member           → the membership assertions below fail.
 *   3. drop the static import         → the source-line assertions below fail
 *      (and the module reference in the array stops resolving, so the build
 *      fails first).
 *
 * The mount `usePlugins` arrays are inline literals inside `runBacklogServer`'s
 * two `requireRun(...)` calls — they are NOT exported and cannot be imported.
 * The provider-independent proof for them is therefore a source read of the
 * exact wiring lines that ship, which is what a reviewer reads too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { USE_PLUGINS } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, '..');
const REPO_ROOT = join(HERE, '..', '..', '..');

const STATIC_IMPORT_LINE = "import { tracingPlugin } from '@adhd/apigen-plugin-tracing';";

function readSrc(name: string): string {
  return readFileSync(join(ENTRYPOINT, 'src', name), 'utf8');
}

describe('backlog is a REQUIRED tracing consumer (FEAT-APIGEN-TRACING)', () => {
  it("USE_PLUGINS carries tracingPlugin (id 'tracing') as its first member", () => {
    const ids = USE_PLUGINS.map((p) => p.id);
    expect(ids).toContain('tracing');
    // Prepended: tracing is the OUTERMOST layer, so the span wraps every other
    // `--use` layer's work rather than the reverse.
    expect(USE_PLUGINS[0]?.id).toBe('tracing');
  });

  it('server.ts statically imports tracingPlugin', () => {
    expect(readSrc('server.ts')).toContain(STATIC_IMPORT_LINE);
  });

  it('cli.ts statically imports tracingPlugin', () => {
    expect(readSrc('cli.ts')).toContain(STATIC_IMPORT_LINE);
  });

  it('the fastify mount wires tracingPlugin ahead of the other plugins', () => {
    expect(readSrc('server.ts')).toContain(
      'usePlugins: [tracingPlugin, openapiPlugin, batchPlugin],'
    );
  });

  it('the MCP mount wires tracingPlugin ahead of the other plugins', () => {
    expect(readSrc('server.ts')).toContain(
      "options: { transport: 'stdio', usePlugins: [tracingPlugin, batchPlugin] },"
    );
  });

  it('the CLI mount wires tracingPlugin ahead of the other plugins', () => {
    expect(readSrc('cli.ts')).toContain(
      'export const USE_PLUGINS: readonly Plugin[] = [tracingPlugin, batchPlugin];'
    );
  });

  it('package.json declares @adhd/apigen-plugin-tracing as a dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(ENTRYPOINT, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['@adhd/apigen-plugin-tracing']).toBeDefined();
  });

  it('the tracing plugin is not merely a `--type` generator (it exposes a layer)', () => {
    // A tracing plugin that lost its `layer` capability would still satisfy the
    // import assertions above while tracing nothing. Assert the capability that
    // makes it load-bearing: an invokable layer function.
    const tracing = USE_PLUGINS.find((p) => p.id === 'tracing');
    expect(tracing).toBeDefined();
    expect(typeof tracing?.capabilities?.layer?.layer).toBe('function');
  });
});
