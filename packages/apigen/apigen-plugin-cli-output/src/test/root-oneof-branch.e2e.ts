// root-oneof-branch.e2e.ts — BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001
// (resource-consuming e2e lane; see the sibling `root-oneof-branch.spec.ts`
// STUB-like counterpart for the in-process unit coverage it keeps).
//
// Resource lane: proc — the generated `cli.ts` source is written to disk next
// to a real target module and driven as a REAL spawned `node` child process
// (`node -r @swc-node/register` → real on-the-fly transpile, real argv
// parsing, real dispatch, real function call) — 2 real subprocesses, each with
// a 30s timeout.
//
// It was extracted out of the default `test` target so `nx affected -t test`
// / the pre-commit + pre-push hooks no longer pay for it. It runs ONLY under
// the explicitly-invoked `nx run apigen-plugin-cli-output:e2e` target via the
// sibling `vitest.e2e.config.ts` — that target is deliberately ABSENT from
// every `test.dependsOn` and from `affected`. The in-process `resolveRootUnion`
// + `generate()` unit tests stay in `root-oneof-branch.spec.ts`; the shared
// fixture both lanes import lives in `./fixtures/root-oneof-branch.fixture.ts`.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PluginInput } from '@adhd/apigen-core-client';
import { generate } from '../lib/generate';
import { dataSchemaProps } from '../lib/schema-introspect';
import { realBatchDomainSchema } from './fixtures/root-oneof-branch.fixture';

const execFileAsync = promisify(execFile);

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
