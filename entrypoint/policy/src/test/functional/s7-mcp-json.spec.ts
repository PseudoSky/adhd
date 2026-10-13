import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupPath, integrityPath } from '../../wrapper/mcp-json/io';
import { mcpJsonVerb } from '../../wrapper/verbs/mcp-json';
import { runCli, useScratchTelemetry } from '../helpers/capture';
import { capturedDeps } from '../helpers/run-deps';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();

const STUB_PATH = '/opt/stubs/notes-server.js';

/** B7.0: one stdio entry "notes" run as node with the stub's path, an env block, an unrelated server and a remote entry. */
const MCP_JSON = `${JSON.stringify(
  {
    mcpServers: {
      notes: { command: 'node', args: [STUB_PATH, '--verbose'], env: { API_TOKEN: 'secret-token' }, disabled: false },
      other: { command: 'python3', args: ['-m', 'other'] },
      remote: { url: 'https://example.invalid/mcp' },
    },
  },
  null,
  2
)}\n`;

interface IFixture {
  readonly dir: string;
  readonly file: string;
  readonly original: Buffer;
}

async function withMcpJson(fn: (f: IFixture) => Promise<void>, text: string = MCP_JSON): Promise<void> {
  await withTmpDir('s7-mcpjson', async (dir) => {
    const file = join(dir, '.mcp.json');
    await writeFile(file, text);
    await fn({ dir, file, original: await readFile(file) });
  });
}

/** Runs the verb from `cwd` and returns its exit code with what it printed. */
async function run(cwd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  const captured = capturedDeps({ cwd });
  const code = await mcpJsonVerb(argv, captured.deps);
  const stdout = captured.stdout.join('');
  return { code, stdout, stderr: captured.stderr.join(''), json: stdout.trim().length > 0 ? (JSON.parse(stdout) as Record<string, unknown>) : {} };
}

const entries = async (file: string): Promise<Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>> =>
  (JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, never> }).mcpServers;

describe('Wrap an unmodified MCP server - mcp-json init and --undo', () => {
  it('@S7.1 init wraps the stdio entry once: adhd-policy serve bin:<cmd> --spec <spec> -- <original args>, env and other keys kept, backup kept (D-10)', async () => {
    await withMcpJson(async (f) => {
      const result = await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ changed: true, wrapped: ['notes', 'other'] });
      const after = await entries(f.file);
      expect(after['notes']).toEqual({
        command: 'adhd-policy',
        args: ['serve', 'bin:node', '--spec', 'notes.yaml', '--', STUB_PATH, '--verbose'],
        env: { API_TOKEN: 'secret-token' },
        disabled: false,
      });
      expect(after['other']?.args?.slice(0, 2)).toEqual(['serve', 'bin:python3']);
      expect(after['remote']).toEqual({ url: 'https://example.invalid/mcp' });
      expect((await readFile(backupPath(f.file))).equals(f.original)).toBe(true);
    });
  });

  it('@S7.1 a second init is a byte-identical no-op and never touches the backup', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      const wrapped = await readFile(f.file);
      const backupStat = await stat(backupPath(f.file));
      const again = await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect(again.code).toBe(0);
      expect(again.json).toMatchObject({ changed: false, wrapped: [] });
      expect((await readFile(f.file)).equals(wrapped)).toBe(true);
      expect((await readFile(backupPath(f.file))).equals(f.original)).toBe(true);
      expect((await stat(backupPath(f.file))).mtimeMs).toBe(backupStat.mtimeMs);
    });
  });

  it('@S7.1 undo restores the original byte for byte, and `init --undo` is the same verb', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect((await run(f.dir, ['--undo'])).code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect((await run(f.dir, ['init', '--undo'])).code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
    });
  });

  it('@S7.1 init then undo then init wraps again from the restored original', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      await run(f.dir, ['--undo']);
      const again = await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect(again.json).toMatchObject({ changed: true });
      expect((await entries(f.file))['notes']?.command).toBe('adhd-policy');
      expect((await readFile(backupPath(f.file))).equals(f.original)).toBe(true);
    });
  });

  it('@S7.1 an entry with no args key still gets the serve arguments; a remote entry is reported, not rewritten', async () => {
    await withMcpJson(
      async (f) => {
        const result = await run(f.dir, ['init', '--spec', 'p.yaml']);
        expect((await entries(f.file))['bare']).toEqual({ command: 'adhd-policy', args: ['serve', 'bin:mcp-bare', '--spec', 'p.yaml', '--'] });
        expect(result.json['skipped']).toEqual([{ name: 'remote', reason: 'remote-entry' }]);
      },
      JSON.stringify({ mcpServers: { bare: { command: 'mcp-bare' }, remote: { url: 'https://example.invalid' } } })
    );
  });

  it('@S7.1 usage errors: init without --spec, an unknown flag, a missing file and invalid JSON each exit non-zero and write nothing', async () => {
    await withMcpJson(async (f) => {
      expect((await run(f.dir, ['init'])).code).toBe(2);
      expect((await run(f.dir, ['init', '--spec', 'a.yaml', '--bogus'])).code).toBe(2);
      expect((await run(f.dir, ['init', '--spec', 'a.yaml', '--file', 'missing.json'])).code).toBe(4);
      await writeFile(join(f.dir, 'bad.json'), '{not json');
      expect((await run(f.dir, ['init', '--spec', 'a.yaml', '--file', 'bad.json'])).code).toBe(2);
      await writeFile(join(f.dir, 'nosrv.json'), '{}');
      expect((await run(f.dir, ['init', '--spec', 'a.yaml', '--file', 'nosrv.json'])).code).toBe(2);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
      expect(await readdir(f.dir)).toEqual(['.mcp.json', 'bad.json', 'nosrv.json']);
    });
  });
});

describe('Review fix E2 - mcp-json --undo only restores a file init wrote', () => {
  it('E2 a file edited after init exits 2, names the change, and is left untouched', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      const edited = `${(await readFile(f.file, 'utf8')).trimEnd()}\n\n`;
      await writeFile(f.file, edited);
      const undo = await run(f.dir, ['--undo']);
      expect(undo.code).toBe(2);
      expect(undo.stderr).toContain('changed since adhd-policy mcp-json init wrote it');
      expect(undo.stderr).toContain('--force');
      expect(await readFile(f.file, 'utf8')).toBe(edited);
    });
  });

  it('E2 --undo --force restores the backup anyway, and a second undo is an idempotent success', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      await writeFile(f.file, '{"mcpServers":{"mine":{"command":"x"}}}\n');
      const forced = await run(f.dir, ['--undo', '--force']);
      expect(forced.code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
      const second = await run(f.dir, ['--undo']);
      expect(second.code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
    });
  });

  it('E2 an old backup with no integrity record needs --force', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      const wrapped = await readFile(f.file);
      await writeFile(integrityPath(f.file), 'not a record');
      const refused = await run(f.dir, ['--undo']);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('cannot be verified');
      expect((await readFile(f.file)).equals(wrapped)).toBe(true);
      expect((await run(f.dir, ['--undo', '--force'])).code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
    });
  });

  it('E2 undo with no backup is not_found (exit 4); a deleted .mcp.json with a backup is restored', async () => {
    await withMcpJson(async (f) => {
      expect((await run(f.dir, ['--undo'])).code).toBe(4);
      await writeFile(backupPath(join(f.dir, 'gone.json')), 'restored-text');
      expect((await run(f.dir, ['--undo', '--file', 'gone.json'])).code).toBe(0);
      expect(await readFile(join(f.dir, 'gone.json'), 'utf8')).toBe('restored-text');
    });
  });
});

describe('Review fix E3 - private backups, kept modes, atomic writes', () => {
  it('E3 the backup and the integrity record are mode 0600 and the file keeps its own mode through init and undo', async () => {
    await withMcpJson(async (f) => {
      await chmod(f.file, 0o640);
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      expect((await stat(backupPath(f.file))).mode & 0o777).toBe(0o600);
      expect((await stat(integrityPath(f.file))).mode & 0o777).toBe(0o600);
      expect((await stat(f.file)).mode & 0o777).toBe(0o640);
      await run(f.dir, ['--undo']);
      expect((await stat(f.file)).mode & 0o777).toBe(0o640);
    });
  });

  it('E3 writes are temp-file-plus-rename: the file is replaced (new inode), never truncated in place, and no temp file is left', async () => {
    await withMcpJson(async (f) => {
      const before = (await stat(f.file)).ino;
      await run(f.dir, ['init', '--spec', 'notes.yaml']);
      const afterInit = (await stat(f.file)).ino;
      expect(afterInit).not.toBe(before);
      await run(f.dir, ['--undo']);
      expect((await stat(f.file)).ino).not.toBe(afterInit);
      expect((await readdir(f.dir)).sort()).toEqual(['.mcp.json', '.mcp.json.adhd-policy.bak', '.mcp.json.adhd-policy.json']);
    });
  });

  it('E3 a symlinked .mcp.json is written through: the link stays a link and its target is what changes', async () => {
    await withTmpDir('s7-symlink', async (dir) => {
      const real = join(dir, 'real');
      await mkdir(real);
      await writeFile(join(real, 'mcp.json'), MCP_JSON);
      const link = join(dir, '.mcp.json');
      await symlink(join(real, 'mcp.json'), link);
      const result = await run(dir, ['init', '--spec', 'notes.yaml']);
      expect(result.code).toBe(0);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await entries(join(real, 'mcp.json')))['notes']?.command).toBe('adhd-policy');
      expect((await run(dir, ['--undo'])).code).toBe(0);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(real, 'mcp.json'), 'utf8')).toBe(MCP_JSON);
    });
  });
});

describe('Review fix E8 - mcp-json init flags', () => {
  it('E8 an unmatched --only name exits 2, names the entries that exist, and writes nothing (no backup, no record)', async () => {
    await withMcpJson(async (f) => {
      const result = await run(f.dir, ['init', '--spec', 'notes.yaml', '--only', 'notes', '--only', 'typo']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('typo');
      expect(result.stderr).toContain('notes, other, remote');
      expect(result.stdout).toBe('');
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
      expect(await readdir(f.dir)).toEqual(['.mcp.json']);
    });
  });

  it('E8 --only wraps just the named entry and reports the rest as not-selected', async () => {
    await withMcpJson(async (f) => {
      const result = await run(f.dir, ['init', '--spec', 'notes.yaml', '--only', 'notes']);
      expect(result.json).toMatchObject({ wrapped: ['notes'] });
      expect(result.json['skipped']).toEqual([
        { name: 'other', reason: 'not-selected' },
        { name: 'remote', reason: 'remote-entry' },
      ]);
      expect((await entries(f.file))['other']?.command).toBe('python3');
    });
  });

  it('E8 an entry already wrapped under a different spec is reported with the old spec and left alone; --replace rewrites it and the original backup survives', async () => {
    await withMcpJson(async (f) => {
      await run(f.dir, ['init', '--spec', 'old.yaml']);
      const wrapped = await readFile(f.file);
      const kept = await run(f.dir, ['init', '--spec', 'new.yaml']);
      expect(kept.code).toBe(0);
      expect(kept.json).toMatchObject({ changed: false, replaced: [] });
      expect(kept.stderr).toContain('notes: already wrapped under --spec old.yaml; pass --replace to rewrite it');
      expect((await readFile(f.file)).equals(wrapped)).toBe(true);

      const replaced = await run(f.dir, ['init', '--spec', 'new.yaml', '--replace']);
      expect(replaced.code).toBe(0);
      expect(replaced.json).toMatchObject({ changed: true, replaced: ['notes', 'other'], wrapped: [] });
      const after = await entries(f.file);
      expect(after['notes']?.args).toEqual(['serve', 'bin:node', '--spec', 'new.yaml', '--', STUB_PATH, '--verbose']);
      expect(after['notes']?.env).toEqual({ API_TOKEN: 'secret-token' });
      expect((await readFile(backupPath(f.file))).equals(f.original)).toBe(true);
      expect((await run(f.dir, ['--undo'])).code).toBe(0);
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
    });
  });

  it('E8 a relative --spec is stored relative to the .mcp.json directory; an absolute --spec is stored as given', async () => {
    await withTmpDir('s7-spec-path', async (dir) => {
      await mkdir(join(dir, 'sub'));
      await mkdir(join(dir, 'policies'));
      await writeFile(join(dir, 'sub', 'mcp.json'), MCP_JSON);
      await run(dir, ['init', '--file', 'sub/mcp.json', '--spec', 'policies/notes.yaml', '--only', 'notes']);
      expect((await entries(join(dir, 'sub', 'mcp.json')))['notes']?.args?.slice(0, 4)).toEqual(['serve', 'bin:node', '--spec', '../policies/notes.yaml']);
      await run(dir, ['--undo', '--file', 'sub/mcp.json']);
      await run(dir, ['init', '--file', 'sub/mcp.json', '--spec', '/etc/policy/notes.yaml', '--only', 'notes']);
      expect((await entries(join(dir, 'sub', 'mcp.json')))['notes']?.args?.slice(0, 4)).toEqual(['serve', 'bin:node', '--spec', '/etc/policy/notes.yaml']);
    });
  });

  it('E8 --force is only valid with --undo and --replace only with init (exit 2, nothing written)', async () => {
    await withMcpJson(async (f) => {
      const force = await run(f.dir, ['init', '--spec', 'a.yaml', '--force']);
      expect(force.code).toBe(2);
      expect(force.stderr).toContain('--force applies to --undo only');
      const replace = await run(f.dir, ['--undo', '--replace']);
      expect(replace.code).toBe(2);
      expect(replace.stderr).toContain('--replace applies to init only');
      expect((await readFile(f.file)).equals(f.original)).toBe(true);
      expect(await readdir(f.dir)).toEqual(['.mcp.json']);
    });
  });

  it('E8 flag values may not start with -- and a missing value is refused', async () => {
    await withMcpJson(async (f) => {
      for (const argv of [['init', '--spec', '--only', 'notes'], ['init', '--spec'], ['init', '--spec=a.yaml', '--file', '--undo']]) {
        const result = await run(f.dir, argv);
        expect(result.code, argv.join(' ')).toBe(2);
      }
      expect(await readdir(f.dir)).toEqual(['.mcp.json']);
    });
  });
});

describe('Review fix E4 - abort handlers only for verbs, through the real command line', () => {
  it('E4 mcp-json (a verb) installs the SIGINT/SIGTERM abort handlers; verify (an apigen command) leaves the listener counts alone', async () => {
    await withMcpJson(async (f) => {
      const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
      const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)] as const));
      try {
        const verify = await runCli(['verify'], { cwd: f.dir, home: f.dir });
        expect(verify.exitCode).toBe(0);
        expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(SIGNALS.map((signal) => before.get(signal)?.length));
        const verb = await runCli(['mcp-json', '--undo', '--file', 'absent.json'], { cwd: f.dir, home: f.dir });
        expect(verb.exitCode).toBe(4);
        expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(SIGNALS.map((signal) => (before.get(signal)?.length ?? 0) + 1));
      } finally {
        for (const signal of SIGNALS) {
          for (const listener of process.listeners(signal)) if (!before.get(signal)?.includes(listener)) process.off(signal, listener as () => void);
        }
      }
    });
  });
});
