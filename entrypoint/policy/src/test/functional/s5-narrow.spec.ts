/**
 * guards: `adhd-policy narrow` widens a child's authority beyond its parent's, mutates its frozen input, or reports the wrong failure shape and exit code.
 * tier: S
 * cites: docs/plan/policy-core/tickets/T15.md (@S5.1, @S5.2, @S5.3, @S5.6; B5.1)
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPolicyClient, parsePolicyYaml, type Attributes, type INarrowResult } from '@adhd/policy-core-client';
import { describe, expect, it } from 'vitest';
import { parseJson, runCli, useScratchTelemetry } from '../helpers/capture';
import { callInput, NARROW_YAML, writePolicy } from '../helpers/fixtures';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();

/** Deep-freezes a value so any in-place write by the code under test throws (modules are strict). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** B5.0: the orchestrator parent for a demo root. */
const parentFor = (demo: string): Attributes => ({
  role: 'orchestrator',
  read_roots: [`${demo}/work`, `${demo}/shared`],
  write_roots: [`${demo}/work/out`],
  repos: ['acme/shop'],
  max_refund: 100,
});

async function withNarrowDemo<T>(
  fn: (demo: string, narrow: (request: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>) => Promise<T>
): Promise<T> {
  return withTmpDir('s5', async (demo) => {
    await writePolicy(demo, NARROW_YAML);
    await mkdir(join(demo, 'work/tests'), { recursive: true });
    await mkdir(join(demo, 'work/src'), { recursive: true });
    const narrow = (request: unknown) =>
      runCli(['narrow', '--input', JSON.stringify({ parent: parentFor(demo), request })], { cwd: demo, home: demo });
    return fn(demo, narrow);
  });
}

describe('Feature: Hand a sub-agent less authority - narrow', () => {
  it('@S5.1 a grant adds, unspecified values are inherited, and the CLI exits 0', async () => {
    await withNarrowDemo(async (demo, narrow) => {
      const result = await narrow({ attributes: { role: 'reviewer' }, grant: { read_roots: [`${demo}/work/tests`] } });
      expect(result.exitCode).toBe(0);
      expect(parseJson(result.stdout)).toEqual({
        ok: true,
        child: {
          role: 'reviewer',
          read_roots: [`${demo}/work/tests`],
          write_roots: [],
          repos: ['acme/shop'],
          max_refund: 100,
        },
      });
    });
  });

  it('@S5.1 nothing is stored or issued: the working directory holds exactly what it held before', async () => {
    await withNarrowDemo(async (demo, narrow) => {
      const before = (await readdir(demo, { recursive: true })).sort();
      await narrow({ attributes: { role: 'reviewer' }, grant: { read_roots: [`${demo}/work/tests`] } });
      expect((await readdir(demo, { recursive: true })).sort()).toEqual(before);
    });
  });

  it('@S5.1 the parent handed to the library is deep-frozen and comes back byte-identical (it is not mutated)', async () => {
    await withTmpDir('s5-lib', async (demo) => {
      const client = createPolicyClient({ layers: [{ name: 'project', source: 'memory:project', document: parsePolicyYaml(NARROW_YAML, 'memory:project') }] });
      const parent = deepFreeze(parentFor(demo));
      const snapshot = JSON.stringify(parent);
      const result = await client.narrow({ parent, request: { attributes: { role: 'reviewer' }, grant: { read_roots: [`${demo}/work/tests`] } } });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(parent)).toBe(snapshot);
      const refused = await client.narrow({ parent, request: { attributes: { role: 'reviewer' }, grant: { max_refund: 900 } } });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(parent)).toBe(snapshot);
    });
  });

  it('@S5.2 only replaces the added set when it lies within it', async () => {
    await withNarrowDemo(async (demo, narrow) => {
      const result = await narrow({
        attributes: { role: 'reviewer' },
        grant: { read_roots: [`${demo}/work/tests`, `${demo}/work/src`] },
        only: { read_roots: [`${demo}/work/src`] },
      });
      expect(result.exitCode).toBe(0);
      expect(parseJson<{ child: { read_roots: string[] } }>(result.stdout).child.read_roots).toEqual([`${demo}/work/src`]);
    });
  });

  describe('@S5.3 a request that would widen authority is refused and names the variable', () => {
    const rows: { name: string; request: (demo: string) => unknown; variable: string }[] = [
      { name: 'grant max_refund 900', request: () => ({ attributes: { role: 'reviewer' }, grant: { max_refund: 900 } }), variable: 'max_refund' },
      { name: 'only read_roots [<DEMO>/home]', request: (demo) => ({ attributes: { role: 'reviewer' }, only: { read_roots: [`${demo}/home`] } }), variable: 'read_roots' },
      { name: 'grant repos [acme/api]', request: () => ({ attributes: { role: 'reviewer' }, grant: { repos: ['acme/api'] } }), variable: 'repos' },
    ];
    for (const row of rows) {
      it(`@S5.3 ${row.name}: ok false, variable ${row.variable}, rule and reason strings, exit 0 (a refusal is data)`, async () => {
        await withNarrowDemo(async (demo, narrow) => {
          const result = await narrow(row.request(demo));
          expect(result.exitCode).toBe(0);
          const outcome = parseJson<Extract<INarrowResult, { ok: false }>>(result.stdout);
          expect(outcome.ok).toBe(false);
          expect(outcome.variable).toBe(row.variable);
          expect(typeof outcome.rule).toBe('string');
          expect(outcome.rule.length).toBeGreaterThan(0);
          expect(typeof outcome.reason).toBe('string');
          expect(outcome.reason.length).toBeGreaterThan(0);
          // Nothing is clamped: a refusal carries no child.
          expect(outcome).not.toHaveProperty('child');
        });
      });
    }
  });

  it('@S5.6 a key the policy cannot check fails closed with rule "uncovered"', async () => {
    await withNarrowDemo(async (_demo, narrow) => {
      const result = await narrow({ attributes: { role: 'reviewer' }, grant: { unknown_var: ['x'] } });
      expect(result.exitCode).toBe(0);
      const outcome = parseJson<Extract<INarrowResult, { ok: false }>>(result.stdout);
      expect(outcome.ok).toBe(false);
      expect(outcome.variable).toBe('unknown_var');
      expect(outcome.rule).toBe('uncovered');
    });
  });

  it('@S5.3 the gate is check on the spawn call: a widened child exits 3, the narrowed child exits 0', async () => {
    await withNarrowDemo(async (demo, _narrow) => {
      const spawn = (child: Record<string, unknown>) =>
        runCli(
          ['check', '--input', callInput({ tool: 'agent.spawn', args: { agent_name: 'reviewer', child }, attributes: parentFor(demo) })],
          { cwd: demo, home: demo }
        );
      const narrowed = { role: 'reviewer', read_roots: [`${demo}/work/tests`], write_roots: [], repos: ['acme/shop'], max_refund: 100 };
      const ok = await spawn(narrowed);
      expect(ok.exitCode).toBe(0);
      const widened = await spawn({ ...narrowed, max_refund: 900 });
      expect(widened.exitCode).toBe(3);
      expect(widened.stdout).toBe('');
    });
  });

  it('@S5.3 a request that is not an object is invalid_argument, exit 2', async () => {
    await withNarrowDemo(async (demo) => {
      const result = await runCli(['narrow', '--input', JSON.stringify({ parent: parentFor(demo), request: 'nope' })], { cwd: demo, home: demo });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
    });
  });
});
