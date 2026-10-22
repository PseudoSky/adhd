/**
 * guards: a policy written with the pre-BA-5 `.` separator loads silently (or fails without naming the new id), `adhd-policy migrate` rewrites the wrong bytes (attribute and context paths, comments, quoting), is not idempotent, or reports a failure with the wrong exit code; and `draft` stops writing `/` ids.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R10 (scenarios 1-4), §3 R10; ADR-0017 D3 (BA-5)
 * red-run: 2026-10-21 control: migrate.ts canonicalToolValue returning its input -> 3 failed (rewrite, canonical-segment and many-files tests).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dispatchVerb } from '../../wrapper/verbs/index';
import { parseJson, runCli, useScratchTelemetry } from '../helpers/capture';
import { capturedDeps } from '../helpers/run-deps';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();
vi.setConfig({ testTimeout: 60_000 });

const OLD_POLICY = `version: 1
attributes:
  role: name
  read_roots: paths
runtime:
  calls: number
permissions:
  # reads
  - tool: files.read
    args: { path: { _within: $attributes.read_roots } }
  - tool: 'files.write'
    context: { role: { _eq: dev }, 'runtime.calls': { _lt: 3 } }
  - tool: "agent.spawn"
    effect: deny
    args: { 'child.read_roots': { _within: $attributes.read_roots } }
`;

async function migrate(dir: string, files: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const captured = capturedDeps({ cwd: dir });
  const result = await dispatchVerb(['migrate', ...files], captured.deps);
  expect(result.handled).toBe(true);
  return { code: result.exitCode ?? -1, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') };
}

describe('policy with the old separator (T-R10)', () => {
  it('loading a policy whose tool uses "." fails and the message names the new id', async () => {
    await withTmpDir('t-r10-old', async (dir) => {
      await writeFile(join(dir, 'workspace-policy.yaml'), OLD_POLICY);
      const verified = await runCli(['verify'], { cwd: dir, home: dir });
      expect(verified.exitCode).not.toBe(0);
      const report = parseJson<{ ok: boolean; errors: Array<{ message: string }> }>(verified.stdout);
      expect(report.ok).toBe(false);
      const messages = report.errors.map((error) => error.message).join('\n');
      expect(messages).toContain('tool "files.read" uses the old separator; use "files/read"');
      expect(messages).toContain('adhd-policy migrate');
    });
  });
});

describe('adhd-policy migrate (T-R10)', () => {
  it('rewrites every tool value in place, prints one line per change, and the migrated policy then loads', async () => {
    await withTmpDir('t-r10-rewrite', async (dir) => {
      const file = join(dir, 'workspace-policy.yaml');
      await writeFile(file, OLD_POLICY);
      const result = await migrate(dir, ['workspace-policy.yaml']);
      expect(result.code).toBe(0);
      expect(result.stdout.split('\n').filter(Boolean)).toEqual([
        'workspace-policy.yaml:9: tool "files.read" -> "files/read"',
        'workspace-policy.yaml:11: tool "files.write" -> "files/write"',
        'workspace-policy.yaml:13: tool "agent.spawn" -> "agent/spawn"',
      ]);
      const text = await readFile(file, 'utf8');
      expect(text).toContain('- tool: files/read\n');
      expect(text).toContain("- tool: 'files/write'\n");
      expect(text).toContain('- tool: "agent/spawn"\n');
      const verified = await runCli(['verify'], { cwd: dir, home: dir });
      expect(verified.exitCode).toBe(0);
      expect(parseJson<{ errors: unknown[] }>(verified.stdout).errors).toEqual([]);
    });
  });

  it('attribute paths with dots, context paths, comments and quoting are byte-for-byte untouched', async () => {
    await withTmpDir('t-r10-dots', async (dir) => {
      const file = join(dir, 'p.yaml');
      await writeFile(file, OLD_POLICY);
      await migrate(dir, ['p.yaml']);
      const migrated = await readFile(file, 'utf8');
      // The only differences between the two texts are the three tool values.
      const normalise = (text: string): string => text.replace(/files\/read|files\.read/, 'T').replace(/files\/write|files\.write/, 'T').replace(/agent\/spawn|agent\.spawn/, 'T');
      expect(normalise(migrated)).toBe(normalise(OLD_POLICY));
      expect(migrated).toContain("'runtime.calls': { _lt: 3 }");
      expect(migrated).toContain("'child.read_roots': { _within: $attributes.read_roots }");
      expect(migrated).toContain('# reads');
    });
  });

  it('a "/" id with a non-canonical segment is rewritten to the canonical spelling (fs/read_file -> fs/read-file)', async () => {
    await withTmpDir('t-r10-canonical', async (dir) => {
      await writeFile(join(dir, 'p.yaml'), 'version: 1\npermissions:\n  - tool: fs/read_file\n  - tool: "*"\n  - tool: bash\n');
      const result = await migrate(dir, ['p.yaml']);
      expect(result.stdout).toBe('p.yaml:3: tool "fs/read_file" -> "fs/read-file"\n');
      expect(await readFile(join(dir, 'p.yaml'), 'utf8')).toBe('version: 1\npermissions:\n  - tool: fs/read-file\n  - tool: "*"\n  - tool: bash\n');
    });
  });

  it('a second run changes nothing: exit 0, nothing on stdout, a note on stderr, the file unchanged', async () => {
    await withTmpDir('t-r10-idempotent', async (dir) => {
      const file = join(dir, 'p.yaml');
      await writeFile(file, OLD_POLICY);
      await migrate(dir, ['p.yaml']);
      const once = await readFile(file, 'utf8');
      const again = await migrate(dir, ['p.yaml']);
      expect(again).toEqual({ code: 0, stdout: '', stderr: 'p.yaml: every tool value is already a canonical operation id\n' });
      expect(await readFile(file, 'utf8')).toBe(once);
    });
  });

  it('several files are migrated in order; a failure stops before the next file', async () => {
    await withTmpDir('t-r10-many', async (dir) => {
      await writeFile(join(dir, 'a.yaml'), 'version: 1\npermissions:\n  - tool: a.b\n');
      await writeFile(join(dir, 'c.yaml'), 'version: 1\npermissions:\n  - tool: c.d\n');
      const ok = await migrate(dir, ['a.yaml', 'c.yaml']);
      expect(ok.stdout.split('\n').filter(Boolean)).toEqual(['a.yaml:3: tool "a.b" -> "a/b"', 'c.yaml:3: tool "c.d" -> "c/d"']);
      await writeFile(join(dir, 'e.yaml'), 'version: 1\npermissions:\n  - tool: e.f\n');
      const stopped = await migrate(dir, ['missing.yaml', 'e.yaml']);
      expect(stopped.code).toBe(4);
      expect(await readFile(join(dir, 'e.yaml'), 'utf8')).toContain('tool: e.f');
    });
  });

  it('failures use the CLI exit table: no file 2, unknown flag 2, not YAML 2, missing file 4', async () => {
    await withTmpDir('t-r10-errors', async (dir) => {
      await writeFile(join(dir, 'bad.yaml'), 'a: [unclosed\n');
      expect((await migrate(dir, [])).code).toBe(2);
      const flag = await migrate(dir, ['--bogus', 'p.yaml']);
      expect(flag.code).toBe(2);
      expect(flag.stderr).toContain('unknown argument --bogus');
      const notYaml = await migrate(dir, ['bad.yaml']);
      expect(notYaml.code).toBe(2);
      expect(notYaml.stderr).toContain('not a YAML policy file');
      const missing = await migrate(dir, ['nope.yaml']);
      expect(missing.code).toBe(4);
      expect(missing.stderr).toContain('no such file');
    });
  });
});

describe('policy draft writes "/" ids (T-R10)', () => {
  it('every tool value in the drafted document keeps the "/" id of its operation, and the drafted policy loads', async () => {
    await withTmpDir('t-r10-draft', async (dir) => {
      const operations = [
        { name: 'files/read-file', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { readOnly: true } },
        { name: 'files/write-file', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'inferred' }], hints: { destructive: true } },
      ];
      const result = await runCli(['draft', '--input', JSON.stringify({ operations, options: { source: 'files' } })], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(0);
      const drafted = parseJson<{ document: { permissions?: Array<{ tool?: string }> }; yaml: string }>(result.stdout);
      const tools = (drafted.document.permissions ?? []).map((permission) => permission.tool).filter((tool): tool is string => typeof tool === 'string');
      expect(tools).toEqual(expect.arrayContaining(['files/read-file', 'files/write-file']));
      expect(tools.filter((tool) => /^[a-z-]+\.[a-z-]+$/.test(tool))).toEqual([]);
      await writeFile(join(dir, 'workspace-policy.yaml'), drafted.yaml);
      expect((await runCli(['verify'], { cwd: dir, home: dir })).exitCode).toBe(0);
    });
  });
});
