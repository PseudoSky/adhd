/**
 * srt-consumer-install.e2e.test.ts — backlog 94125709.
 *
 * "srt discovery for published/npx installs of @adhd/agent-mcp is unproven."
 * In-repo the server finds `srt` because resolveNativeBinDir() injects
 * <repo>/node_modules/.bin. A consumer has no repo: `@anthropic-ai/sandbox-
 * runtime` is a dependency of agent-core-native-tooling, not agent-mcp.
 *
 * DEFAULT-RUNNING (no env gate). Everything is real except the LLM boundary:
 *   - the built dist/ of agent-mcp AND its whole @adhd/* dependency closure is
 *     `npm pack`ed (as release does) and `npm i`-ed from tarballs into a fresh
 *     directory OUTSIDE the repo — no workspace symlinks;
 *   - the INSTALLED `node_modules/.bin/agent-mcp` is launched from a neutral cwd
 *     with every `node_modules/.bin` stripped from PATH;
 *   - a real MCP client drives `agent_create` + `task{cwd}` over stdio;
 *   - the real srt-wrapped fs/shell builtins run; the scripted LLM is the only stub.
 * Needs the npm registry (third-party deps, as for any consumer) and npx/uvx;
 * missing prerequisites fail loudly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installConsumer, installedBin, packClosure } from './consumer-install.js';
import {
  FakeLlm,
  srtOnPath,
  startPortabilityHost,
  type PortabilityHost,
  type ScriptedCall,
} from './portability-host.js';

const real = (p: string) => fs.realpathSync(p);
const shCall = (command: string[]): ScriptedCall => ({
  server: 'shell',
  tool: 'shell_execute',
  args: { command },
});
const fsCall = (tool: string, args: Record<string, unknown>): ScriptedCall => ({
  server: 'fs',
  tool,
  args,
});

let scratch = '';
let homeRoot = '';
let consumer = '';
let consumerNoSrt = '';
let llm: FakeLlm;
const hosts: PortabilityHost[] = [];

async function startFrom(consumerDir: string, tag: string): Promise<PortabilityHost> {
  const s = path.join(scratch, tag);
  const serverCwd = path.join(s, 'server-cwd');
  fs.mkdirSync(serverCwd, { recursive: true });
  const host = await startPortabilityHost({
    serverCwd,
    scratch: s,
    entry: installedBin(consumerDir),
  });
  hosts.push(host);
  return host;
}

async function createAgent(host: PortabilityHost, name: string): Promise<Record<string, unknown>> {
  return host.callJson('agent_create', {
    name,
    provider: { type: 'openai', model: 'fake', baseURL: llm.baseURL },
    systemPrompt: 'consumer install test',
    nativeTooling: { fs: { root: 'proj' }, shell: { allowCommands: ['pwd', 'touch'] }, dispatch: false },
  });
}

beforeAll(async () => {
  const stamp = `srt-consumer-94125709-${process.pid}-`;
  scratch = real(fs.mkdtempSync(path.join(os.tmpdir(), stamp)));
  // Caller cwds live under ~/.adhd/tmp: NOT under the OS tmpdir, which srt's
  // static allow-list already covers — so a write there is allowed only if the
  // per-run policy (and therefore srt) is really in force.
  fs.mkdirSync(path.join(os.homedir(), '.adhd', 'tmp'), { recursive: true });
  homeRoot = real(fs.mkdtempSync(path.join(os.homedir(), '.adhd', 'tmp', stamp)));

  const tarballs = packClosure(path.join(scratch, 'tarballs'));
  consumer = installConsumer(path.join(scratch, 'consumer'), tarballs);
  consumerNoSrt = installConsumer(path.join(scratch, 'consumer-no-srt'), tarballs);
  // The variant where srt is genuinely absent: no bin link, no package.
  fs.rmSync(path.join(consumerNoSrt, 'node_modules', '.bin', 'srt'), { force: true });
  fs.rmSync(path.join(consumerNoSrt, 'node_modules', '@anthropic-ai', 'sandbox-runtime'), {
    recursive: true,
    force: true,
  });

  llm = new FakeLlm();
  await llm.start();
}, 600_000);

afterAll(async () => {
  for (const h of hosts) await h.close();
  await llm?.stop();
  for (const d of [scratch, homeRoot]) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('94125709: packed, consumer-installed @adhd/agent-mcp and srt', () => {
  it('94125709 AC1: installed (non-workspace) server finds srt off a stripped PATH and srt-wraps fs/shell children', async () => {
    // Precondition: this really is a consumer install — a real directory, not a workspace symlink.
    const installed = path.join(consumer, 'node_modules', '@adhd', 'agent-mcp');
    expect(fs.lstatSync(installed).isSymbolicLink(), 'must not be a workspace symlink').toBe(false);
    expect(real(installed).startsWith(consumer)).toBe(true);

    const host = await startFrom(consumer, 'ac1');
    expect(srtOnPath(host.path), 'precondition: srt absent from the launch PATH').toBe(false);
    const created = await createAgent(host, 'consumer-agent');
    expect(created['_isError'], JSON.stringify(created)).toBeUndefined();

    const cwd = path.join(homeRoot, 'work');
    for (const d of ['proj', 'x']) fs.mkdirSync(path.join(cwd, d), { recursive: true });
    const outside = `${real(cwd)}-outside`;
    fs.mkdirSync(outside, { recursive: true });
    const inside = path.join(real(cwd), 'shell-wrote.txt');
    const leak = path.join(real(outside), 'shell-leak.txt');
    const fsInside = path.join(real(cwd), 'proj', 'fs-wrote.txt');

    llm.setScript('ac1', [
      [shCall(['pwd'])],
      [shCall(['touch', inside])],
      [shCall(['touch', leak])],
      [fsCall('write_file', { path: fsInside, content: 'consumer-fs' })],
    ]);
    const out = await host.callJson('task', {
      agent_name: 'consumer-agent',
      prompt: 'CASE:ac1 go',
      cwd: real(cwd),
    });
    expect(out['_isError'], JSON.stringify(out)).toBeUndefined();
    expect(out['status'], JSON.stringify(out)).toBe('completed');

    // The shell child ran (pwd == caller cwd) and could write INSIDE the cwd...
    expect(llm.resultsFor('ac1').join('\n')).toContain(real(cwd));
    expect(fs.existsSync(inside), 'shell write inside cwd must succeed').toBe(true);
    expect(fs.readFileSync(fsInside, 'utf8')).toBe('consumer-fs');
    // ...and srt DENIED the write outside it (the cwd is not under tmpdir, so only
    // an srt policy that is really enforced can explain the denial).
    expect(fs.existsSync(leak), 'srt must deny a write outside the allowed roots').toBe(false);
    expect(llm.resultsFor('ac1').join('\n')).toMatch(/not permitted|denied|read-only/i);

    // The per-run srt policy the server provisioned exists and carries this cwd.
    expect(fs.existsSync(host.srtSettingsPath), 'srt policy file must exist').toBe(true);
    const policy = JSON.parse(fs.readFileSync(host.srtSettingsPath, 'utf8')) as {
      filesystem: { allowWrite: string[] };
    };
    expect(policy.filesystem.allowWrite).toContain(real(cwd));
  }, 600_000);

  it('94125709 AC2: with srt absent from the install, the task fails LOUDLY naming srt — never silently unsandboxed', async () => {
    const host = await startFrom(consumerNoSrt, 'ac2');
    const created = await createAgent(host, 'consumer-agent-nosrt');
    expect(created['_isError'], JSON.stringify(created)).toBeUndefined();

    const cwd = path.join(homeRoot, 'work-nosrt');
    fs.mkdirSync(path.join(cwd, 'proj'), { recursive: true });
    const marker = path.join(real(cwd), 'unsandboxed.txt');
    llm.setScript('ac2', [[shCall(['touch', marker])]]);
    const out = await host.callJson('task', {
      agent_name: 'consumer-agent-nosrt',
      prompt: 'CASE:ac2 go',
      cwd: real(cwd),
    });
    const blob = JSON.stringify(out) + llm.resultsFor('ac2').join('\n');
    // Never silently unsandboxed: the unwrapped command must not have run.
    expect(fs.existsSync(marker), 'a shell child must not run without srt').toBe(false);
    // Loud + named: the failure surfaces an error that names srt / sandbox-runtime.
    expect(out['status'] === 'completed' && !/srt|sandbox-runtime/i.test(blob), blob).toBe(false);
    expect(blob).toMatch(/srt|sandbox-runtime/i);
  }, 600_000);
});
