import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJson, runCli, useScratchTelemetry } from '../helpers/capture';
import { callInput, devAttributes, SUPPORT_ATTRIBUTES, WORKSPACE_YAML, writePolicy } from '../helpers/fixtures';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();

interface IDecisionJson {
  effect: string;
  set: Record<string, unknown>;
  matched: string[];
  denial?: { code: string; reason: string };
}

/**
 * A real demo directory holding the B2.0 policy file and the files it names.
 * `cwd` is the demo (so discovery finds the policy) and `home` is the demo
 * too, so the walk-up never leaves the scratch directory.
 */
async function withDemo<T>(fn: (demo: string, run: (argv: string[]) => ReturnType<typeof runCli>) => Promise<T>): Promise<T> {
  return withTmpDir('s2', async (demo) => {
    await writePolicy(demo, WORKSPACE_YAML);
    for (const file of ['work/readme.md', 'work/.env', 'work/out/notes.txt']) {
      await mkdir(dirname(join(demo, file)), { recursive: true });
      await writeFile(join(demo, file), 'x');
    }
    return fn(demo, (argv) => runCli(argv, { cwd: demo, home: demo }));
  });
}

describe('Feature: Gate a script on an exit code - check and evaluate', () => {
  it('@S2.1 an allowed call exits 0 with the decision on stdout', async () => {
    await withDemo(async (demo, run) => {
      const result = await run(['check', '--input', callInput({ tool: 'files.read', args: { path: `${demo}/work/readme.md` }, attributes: devAttributes(demo) })]);
      expect(result.exitCode).toBe(0);
      const decision = parseJson<IDecisionJson>(result.stdout);
      expect(decision.effect).toBe('allow');
      expect(decision.set).toEqual({});
    });
  });

  it('@S2.1 the command also answers without the namespace prefix and with the prefix spelled out', async () => {
    await withDemo(async (demo, run) => {
      const input = callInput({ tool: 'files.read', args: { path: `${demo}/work/readme.md` }, attributes: devAttributes(demo) });
      const bare = await run(['check', '--input', input]);
      const prefixed = await run(['policy', 'check', '--input', input]);
      expect(prefixed.exitCode).toBe(0);
      expect(parseJson(prefixed.stdout)).toEqual(parseJson(bare.stdout));
    });
  });

  it('@S2.1 a forced value on an allowed write is printed in the decision set (B2.4)', async () => {
    await withDemo(async (demo, run) => {
      const result = await run([
        'check',
        '--input',
        callInput({ tool: 'files.write', args: { path: `${demo}/work/out/notes.txt`, content: 'hi' }, attributes: devAttributes(demo) }),
      ]);
      expect(result.exitCode).toBe(0);
      expect(parseJson<IDecisionJson>(result.stdout).set).toEqual({ overwrite: false });
    });
  });

  it('@S2.2 a secret path is refused with exit 3, no decision on stdout, and stderr naming the deny', async () => {
    await withDemo(async (demo, run) => {
      const result = await run(['check', '--input', callInput({ tool: 'files.read', args: { path: `${demo}/work/.env` }, attributes: devAttributes(demo) })]);
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('permission_denied');
      // The error body carries the decision; the matched deny (project:2) is named in it.
      expect(result.stderr).toContain('explicit-deny');
      expect(result.stderr).toContain('project:2');
    });
  });

  it('@S2.3 evaluate reports where check gates: same .env read exits 0 with deny / explicit-deny and the matched deny id', async () => {
    await withDemo(async (demo, run) => {
      const result = await run(['evaluate', '--input', callInput({ tool: 'files.read', args: { path: `${demo}/work/.env` }, attributes: devAttributes(demo) })]);
      expect(result.exitCode).toBe(0);
      const decision = parseJson<IDecisionJson>(result.stdout);
      expect(decision.effect).toBe('deny');
      expect(decision.denial?.code).toBe('explicit-deny');
      expect(decision.matched).toContain('project:2');
    });
  });

  describe('@S2.5 a caller who supplies nothing is a guest and is denied', () => {
    const rows = [
      { tool: 'files.write', args: (demo: string) => ({ path: `${demo}/work/out/notes.txt` }), code: 'no-match' },
      { tool: 'billing.refund', args: () => ({ customer: 'cust_1', amount: 1 }), code: 'explicit-deny' },
    ];
    for (const row of rows) {
      it(`@S2.5 ${row.tool}: evaluate denies with ${row.code}; check exits 3`, async () => {
        await withDemo(async (demo, run) => {
          const input = callInput({ tool: row.tool, args: row.args(demo) });
          const evaluated = await run(['evaluate', '--input', input]);
          expect(evaluated.exitCode).toBe(0);
          const decision = parseJson<IDecisionJson>(evaluated.stdout);
          expect(decision.effect).toBe('deny');
          expect(decision.denial?.code).toBe(row.code);
          expect((await run(['check', '--input', input])).exitCode).toBe(3);
        });
      });
    }
  });

  describe('@S2.6 refund limits decide between ask and deny', () => {
    const rows = [
      { amount: 40, effect: 'ask', code: undefined },
      { amount: 90, effect: 'deny', code: 'no-match' },
    ];
    for (const row of rows) {
      it(`@S2.6 amount ${row.amount}: evaluate is ${row.effect}${row.code ? ` / ${row.code}` : ''}; check exits 3`, async () => {
        await withDemo(async (_demo, run) => {
          const input = callInput({ tool: 'billing.refund', args: { customer: 'cust_1', amount: row.amount }, attributes: SUPPORT_ATTRIBUTES });
          const evaluated = await run(['evaluate', '--input', input]);
          expect(evaluated.exitCode).toBe(0);
          const decision = parseJson<IDecisionJson>(evaluated.stdout);
          expect(decision.effect).toBe(row.effect);
          if (row.code !== undefined) expect(decision.denial?.code).toBe(row.code);
          const checked = await run(['check', '--input', input]);
          expect(checked.exitCode).toBe(3);
          expect(checked.stdout).toBe('');
          // When the effect is ask the refusal reason says so (D-15).
          if (row.effect === 'ask') expect(checked.stderr.toLowerCase()).toContain('ask');
        });
      });
    }
  });

  it('@S2.9 a call without a tool is rejected before any decision: exit 2 and stderr names the missing tool', async () => {
    await withDemo(async (_demo, run) => {
      const result = await run(['check', '--input', callInput({ args: {} })]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('invalid_argument');
      expect(result.stderr).toContain("'tool'");
    });
  });

  it('@S2.9 a flag the command does not have (the demo wording --tool) is invalid_argument, exit 2', async () => {
    await withDemo(async (_demo, run) => {
      const result = await run(['check', '--tool', 'files.read']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('invalid_argument');
    });
  });

  it('@S2.9 evaluate rejects a malformed call the same way: exit 2, never a decision', async () => {
    await withDemo(async (_demo, run) => {
      const result = await run(['evaluate', '--input', '{"args":{}}']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
    });
  });

  it('@S2.1 the policy source is announced on stderr, not stdout (D-12)', async () => {
    await withDemo(async (demo, run) => {
      const result = await run(['evaluate', '--input', callInput({ tool: 'files.read', args: { path: `${demo}/work/readme.md` }, attributes: devAttributes(demo) })]);
      expect(result.stderr).toContain(`policy: ${join(demo, 'workspace-policy.yaml')}`);
      expect(result.stdout).not.toContain('policy:');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  it('@S2.5 with no policy file anywhere the built-in deny-all default applies and is announced (D-10)', async () => {
    await withTmpDir('s2-nopolicy', async (dir) => {
      const input = callInput({ tool: 'files.read', args: { path: '/x' } });
      const evaluated = await runCli(['evaluate', '--input', input], { cwd: dir, home: dir });
      expect(evaluated.exitCode).toBe(0);
      expect(parseJson<IDecisionJson>(evaluated.stdout).effect).toBe('deny');
      expect(evaluated.stderr).toContain('policy: built-in');
      expect((await runCli(['check', '--input', input], { cwd: dir, home: dir })).exitCode).toBe(3);
    });
  });
});
