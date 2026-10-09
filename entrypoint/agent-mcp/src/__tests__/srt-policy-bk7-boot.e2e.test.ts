/**
 * BK7 (backlog 515a2b50, plan 9ed453c1) SEC-F6 — e2e lane (ADR-0009).
 *
 * An invalid `agent.shell.sandbox.extraAllowWrite` / `extraAllowWriteRoots` is a security-config error:
 * the REAL built entrypoint (dist/src/index.js) must refuse to start (non-zero exit, a clear message
 * naming the key and the offending entry) rather than boot with a degraded sandbox. The control proves
 * the same launch with the shipped default boots and answers a real MCP request, so the refusal is the
 * config validation and not an unrelated startup failure. Isolated fake HOME + cwd; the real `~/.adhd`
 * is never touched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');

let tmpDir = '';
let fakeHome = '';
let cwd = '';

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ADHD_') || value === undefined) continue;
    env[key] = value;
  }
  env.HOME = fakeHome;
  env.ADHD_AGENT_TRANSPORT = 'stdio';
  env.ADHD_AGENT_SSE_ENABLED = 'false';
  env.ADHD_AGENT_SKIP_LEGACY_MIGRATION = 'true';
  return { ...env, ...extra };
}

function boot(extra: Record<string, string>) {
  return spawnSync(process.execPath, [DIST_ENTRY], { cwd, env: childEnv(extra), encoding: 'utf8', input: '', timeout: 60_000 });
}

describe('515a2b50 SEC-F6 invalid sandbox write config aborts startup', () => {
  beforeAll(() => {
    expect(fs.existsSync(DIST_ENTRY), `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp" first`).toBe(true);
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bk7-boot-')));
    fakeHome = path.join(tmpDir, 'home');
    cwd = path.join(tmpDir, 'cwd');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['a protected dir', { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE: '~/.ssh' }, '~/.ssh'],
    ['a shell rc file', { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE: '~/.zshrc' }, '~/.zshrc'],
    ['an unrelated dir without a declared root', { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE: '~/work/x' }, '~/work/x'],
    ['an invalid trust root', { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS: '~/.adhd' }, '~/.adhd'],
  ])('refuses to start with %s', (_label, extra, entry) => {
    const out = boot(extra);
    expect(out.status, `stdout=${out.stdout}\nstderr=${out.stderr}`).toBe(1);
    expect(out.stderr).toContain('Refusing to start');
    expect(out.stderr).toContain('agent.shell.sandbox.extraAllowWrite');
    expect(out.stderr).toContain(entry);
  }, 90_000);

  it('CONTROL: the shipped default boots, provisions the policy and answers a real MCP request', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_ENTRY], env: childEnv(), cwd, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const client = new Client({ name: 'bk7-boot-e2e', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'agent_list', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(stderr).toContain('Provisioned srt sandbox policy');
      expect(stderr).not.toContain('Refusing to start');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 90_000);
});
