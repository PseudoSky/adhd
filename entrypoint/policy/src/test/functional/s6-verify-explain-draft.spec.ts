/**
 * guards: `verify`, `explain` or `draft` accept a broken policy file, name the wrong rule, or report a wrong exit code, so an author ships a policy that does not mean what it says.
 * tier: S
 * cites: docs/plan/policy-core/tickets/T16.md (@S6.1, @S6.2, @S6.3, @S6.4; B6.1)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IDraftPolicy, IExplanation, IPolicyIssue, IResolved, IVerifyReport } from '@adhd/policy-core-client';
import { describe, expect, it } from 'vitest';
import { parseJson, runCli, useScratchTelemetry } from '../helpers/capture';
import { BROKEN_YAML, callInput, devAttributes, WORKSPACE_YAML, writePolicy } from '../helpers/fixtures';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();

const BROKEN_CODES = ['unknown-operator', 'undeclared-attribute', 'layer-violation', 'runtime-without-provider'];

/** `$DEMO` holds the good B2.0 file; `$DEMO/bad` holds the broken B6.2 file; `$DEMO/work` has no file of its own. */
async function withDemo<T>(fn: (demo: string) => Promise<T>): Promise<T> {
  return withTmpDir('s6', async (demo) => {
    await writePolicy(demo, WORKSPACE_YAML);
    await writePolicy(join(demo, 'bad'), BROKEN_YAML);
    for (const file of ['work/readme.md', 'work/.env']) {
      await mkdir(dirname(join(demo, file)), { recursive: true });
      await writeFile(join(demo, file), 'x');
    }
    return fn(demo);
  });
}

const at = (demo: string, sub: string) => join(demo, sub);
const issueCodes = (issues: readonly IPolicyIssue[]): string[] => issues.map((issue) => issue.code);

describe('Feature: Know what a policy says before you ship it', () => {
  it('@S6.1 a good file verifies clean: no errors, no warnings, exit 0', async () => {
    await withDemo(async (demo) => {
      const result = await runCli(['verify'], { cwd: demo, home: demo });
      expect(result.exitCode).toBe(0);
      const report = parseJson<IVerifyReport>(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
    });
  });

  it('@S6.2 a broken file reports every defect with its JSON path, the warning, and exit 2', async () => {
    await withDemo(async (demo) => {
      const result = await runCli(['verify'], { cwd: at(demo, 'bad'), home: demo });
      expect(result.exitCode).toBe(2);
      const report = parseJson<IVerifyReport>(result.stdout);
      expect(report.ok).toBe(false);
      const errorCodes = issueCodes(report.errors);
      for (const code of ['unknown-operator', 'undeclared-attribute', 'layer-violation']) expect(errorCodes, code).toContain(code);
      expect(issueCodes(report.warnings)).toContain('runtime-without-provider');
      // Every issue locates itself in the document.
      for (const issue of [...report.errors, ...report.warnings]) {
        expect(typeof issue.path, `${issue.code} path`).toBe('string');
        expect(issue.path.length, `${issue.code} path`).toBeGreaterThan(0);
      }
    });
  });

  it('@S6.2 none of those codes appears when the good file is verified', async () => {
    await withDemo(async (demo) => {
      const result = await runCli(['verify'], { cwd: demo, home: demo });
      for (const code of BROKEN_CODES) expect(result.stdout).not.toContain(code);
    });
  });

  it('@S6.2 warnings alone keep exit 0 (D-05): a runtime read with no provider is a warning, not a failure', async () => {
    await withTmpDir('s6-warn', async (dir) => {
      await writePolicy(
        dir,
        `version: 1
attributes:
  role: name
runtime:
  calls: number
permissions:
  - tool: slack/post
    context: { 'runtime.calls': { _lt: 3 } }
`
      );
      const result = await runCli(['verify'], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(0);
      const report = parseJson<IVerifyReport>(result.stdout);
      expect(report.errors).toEqual([]);
      expect(issueCodes(report.warnings)).toContain('runtime-without-provider');
    });
  });

  it('@S6.3 a policy that does not load stops the tool: no decision, stderr names the file, exit 1', async () => {
    await withDemo(async (demo) => {
      const bad = at(demo, 'bad');
      const result = await runCli(['check', '--input', callInput({ tool: 'files/read', args: { path: '/etc/hosts' } })], { cwd: bad, home: demo });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(join(bad, 'workspace-policy.yaml'));
    });
  });

  it('@S6.3 evaluate on the unloadable policy also exits 1, never 0 and never a decision', async () => {
    await withDemo(async (demo) => {
      const result = await runCli(['evaluate', '--input', callInput({ tool: 'files/read', args: { path: '/etc/hosts' } })], { cwd: at(demo, 'bad'), home: demo });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    });
  });

  it("@S6.3 the same call where a good file is found yields that file's decision, never partial rules from the broken one", async () => {
    await withDemo(async (demo) => {
      const input = callInput({ tool: 'files/read', args: { path: `${demo}/work/readme.md` }, attributes: devAttributes(demo) });
      const result = await runCli(['check', '--input', input], { cwd: at(demo, 'work'), home: demo });
      expect(result.exitCode).toBe(0);
      expect(parseJson<{ effect: string; matched: string[] }>(result.stdout)).toMatchObject({ effect: 'allow', matched: ['project:0'] });
      expect(result.stderr).toContain(join(demo, 'workspace-policy.yaml'));
      expect(result.stderr).not.toContain(join(demo, 'bad'));
    });
  });

  it('@S6.4 explain a refusal: deny / explicit-deny, the read allow and the secret deny both matched, substituted _within equals read_roots', async () => {
    await withDemo(async (demo) => {
      const attributes = devAttributes(demo);
      const result = await runCli(['explain', '--input', callInput({ tool: 'files/read', args: { path: `${demo}/work/.env` }, attributes })], {
        cwd: demo,
        home: demo,
      });
      expect(result.exitCode).toBe(0);
      const explanation = parseJson<IExplanation>(result.stdout);
      expect(explanation.decision.effect).toBe('deny');
      expect(explanation.decision.denial?.code).toBe('explicit-deny');
      expect(explanation.considered.filter((entry) => entry.argsMatched === true).length).toBeGreaterThanOrEqual(2);
      const read = explanation.considered.find((entry) => entry.id === 'project:0');
      expect(read?.argsMatched).toBe(true);
      expect(JSON.stringify(read?.substituted)).toBe(JSON.stringify({ path: { _within: attributes['read_roots'] } }));
    });
  });

  it('@S6.5 resolve shows where an effective value came from: supplied vs a project defaults rule', async () => {
    await withDemo(async (demo) => {
      const result = await runCli(['resolve', '--input', JSON.stringify({ attributes: { role: 'dev' } })], { cwd: demo, home: demo });
      expect(result.exitCode).toBe(0);
      const resolved = parseJson<IResolved>(result.stdout);
      expect(resolved.attributes['role']).toBe('dev');
      expect(resolved.provenance['role']).toBe('supplied');
      expect(resolved.attributes['max_refund']).toBe(0);
      expect(resolved.provenance['max_refund']).toMatch(/^project:/);
    });
  });

  it('@S6.6 draft: read-only operations are allow, the destructive one is deny, a secret-path deny is included, the document is version 1', async () => {
    const operations = [
      { name: 'read_file', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { readOnly: true } },
      { name: 'list_dir', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { readOnly: true } },
      {
        name: 'write_file',
        args: [
          { name: 'path', type: 'string', kind: 'path', provenance: 'inferred' },
          { name: 'content', type: 'string', kind: 'text', provenance: 'declared' },
        ],
        hints: { destructive: true },
      },
    ];
    await withTmpDir('s6-draft', async (dir) => {
      const result = await runCli(['draft', '--input', JSON.stringify({ operations, options: { source: 'files' } })], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(0);
      const drafted = parseJson<IDraftPolicy>(result.stdout);
      expect(drafted.document.version).toBe(1);
      const permissions = drafted.document.permissions ?? [];
      const effectOf = (tool: string) => permissions.find((permission) => permission.tool === tool)?.effect ?? 'allow';
      for (const tool of ['read_file', 'list_dir', 'write_file']) {
        expect(
          permissions.some((permission) => permission.tool === tool),
          `${tool} is covered`
        ).toBe(true);
      }
      expect(effectOf('read_file')).toBe('allow');
      expect(effectOf('list_dir')).toBe('allow');
      expect(effectOf('write_file')).toBe('deny');
      expect(permissions.some((permission) => permission.effect === 'deny' && JSON.stringify(permission.args ?? {}).includes('_regex'))).toBe(true);
      expect(drafted.inferred.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('@S6.6 the drafted yaml is itself valid: written as the discovered policy, verify exits 0', async () => {
    await withTmpDir('s6-drafted', async (dir) => {
      const input = {
        operations: [
          { name: 'read_file', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { readOnly: true } },
          { name: 'write_file', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { destructive: true } },
        ],
        options: { source: 'files' },
      };
      const drafted = parseJson<IDraftPolicy>((await runCli(['draft', '--input', JSON.stringify(input)], { cwd: dir, home: dir })).stdout);
      await writePolicy(join(dir, 'drafted'), drafted.yaml);
      const verified = await runCli(['verify'], { cwd: join(dir, 'drafted'), home: dir });
      expect(verified.exitCode).toBe(0);
      expect(parseJson<IVerifyReport>(verified.stdout).errors).toEqual([]);
    });
  });

  it('@S6.6 draft with no operations list is invalid_argument, exit 2', async () => {
    await withTmpDir('s6-draft-bad', async (dir) => {
      const result = await runCli(['draft', '--input', '{"operations":"x"}'], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
    });
  });
});
