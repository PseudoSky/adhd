/**
 * agent-portability.e2e.test.ts — dispatch-2026-10-06-48dc.
 *
 * Question under test: "can agents successfully be started in different areas
 * of the fs and execute correctly?" — i.e. native fs + shell tools resolve
 * relative to THE CALLER'S cwd, never the host's, and are DENIED outside it.
 *
 * DEFAULT-RUNNING (no env gate). Everything is real except the LLM boundary:
 *   - the BUILT agent-mcp (`dist/src/index.js`) launched as a child process
 *     whose OWN cwd is a neutral dir outside the repo, with `node_modules/.bin`
 *     stripped from PATH (so `srt` discovery is the server's job — 48dc-PORT AC3);
 *   - a real MCP client over stdio JSON-RPC (`agent_create`, `task{cwd}`);
 *   - the real orchestrator + the real adopted fs (`@modelcontextprotocol/
 *     server-filesystem`) and shell (`mcp-shell-server`) servers under `srt`;
 *   - the LLM is a local OpenAI-compatible endpoint (`FakeLlm`) — the ONLY stub.
 * Assertions are on BYTES ON DISK and on the tool results the real servers fed
 * back to the agent loop — never on model prose.
 *
 * Prerequisites (npx, uvx, a built dist) FAIL LOUDLY; nothing here self-skips.
 * The paid-model leg lives in `agent-portability-live.e2e.test.ts` (NAT_TOOL_LIVE).
 *
 * c9f0a791 AC7 — covering set only (QA static redundancy triage): the srt-discovery
 * precheck, `home-nontmp` cases (a)(b)(c)(e)(f) and `space` cases (a)(e). `plain`/`deep`
 * cwds sit under os.tmpdir() (already in srt's static allow-list) and add no branch the
 * two kept cwds miss. c9f0a791 AC4 — a fake `npx` first on the server PATH proves no
 * fs/shell task ever shells out to npx. c9f0a791 AC2 — three consecutive green runs.
 *
 * Citations: ticket 7e854708 (was 99cb14a7) — AC6 "every resolved root is unioned
 * into the per-run srt policy's allowWrite"; the caller cwd is the spawned
 * builtins' process cwd and must be in that union even when `fs.root` is explicit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';

import {
  FakeLlm,
  REPO_ROOT,
  makeNpxShim,
  srtOnPath,
  startPortabilityHost,
  type PortabilityHost,
  type ScriptedCall,
} from './portability-host.js';

interface CwdFixture {
  label: string;
  /** Caller cwd (realpath). */
  cwd: string;
  /** A sibling directory OUTSIDE the cwd holding a secret. */
  outside: string;
  secret: string;
  token: string;
  /** True when the cwd is NOT under the OS tmpdir (the static srt allow-list). */
  nonTmp: boolean;
}

const real = (p: string) => fs.realpathSync(p);
const results: Array<[string, string, string]> = [];

let scratch = '';
let tmpRoot = '';
let homeRoot = '';
let shared = '';
let llm: FakeLlm;
let host: PortabilityHost;
let npxShim: { dir: string; marker: string };
const fixtures: CwdFixture[] = [];

function mkFixture(label: string, cwd: string, nonTmp: boolean, i: number): CwdFixture {
  fs.mkdirSync(cwd, { recursive: true });
  const c = real(cwd);
  for (const d of ['proj', 'a', 'b', 'c']) fs.mkdirSync(path.join(c, d), { recursive: true });
  const outside = `${c}-outside`;
  fs.mkdirSync(outside, { recursive: true });
  const secret = `SECRET-${i}-${Date.now()}`;
  fs.writeFileSync(path.join(outside, 'secret.txt'), secret);
  return { label, cwd: c, outside: real(outside), secret, token: `TOKEN-${i}-${Date.now()}`, nonTmp };
}

beforeAll(async () => {
  const stamp = `portability-48dc-${process.pid}-`;
  scratch = real(fs.mkdtempSync(path.join(os.tmpdir(), `${stamp}scratch-`)));
  tmpRoot = real(fs.mkdtempSync(path.join(os.tmpdir(), `${stamp}cwds-`)));
  fs.mkdirSync(path.join(os.homedir(), '.adhd', 'tmp'), { recursive: true });
  homeRoot = real(fs.mkdtempSync(path.join(os.homedir(), '.adhd', 'tmp', stamp)));
  shared = path.join(tmpRoot, 'shared-alias-target');
  fs.mkdirSync(shared, { recursive: true });
  shared = real(shared);

  // Two caller cwds, BOTH outside the repo: one with whitespace (spawn/srt quoting)
  // and one NOT under the OS tmpdir (the static srt allow-list) — the 99cb14a7 case.
  fixtures.push(
    mkFixture('space', path.join(tmpRoot, 'dir with space'), false, 0),
    mkFixture('home-nontmp', path.join(homeRoot, 'work'), true, 1)
  );
  for (const f of fixtures) expect(f.cwd.startsWith(REPO_ROOT)).toBe(false);

  llm = new FakeLlm();
  await llm.start();
  const serverCwd = path.join(scratch, 'server-cwd');
  fs.mkdirSync(serverCwd, { recursive: true });
  // c9f0a791 AC4: a fake `npx` FIRST on the server PATH (writes a marker, exits 99).
  npxShim = makeNpxShim(path.join(scratch, 'npx-shim'));
  host = await startPortabilityHost({
    serverCwd,
    scratch,
    pathPrefix: npxShim.dir,
    env: { ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_ROOTS: `shared=${shared}` },
  });

  const provider = { type: 'openai', model: 'fake', baseURL: llm.baseURL };
  const base = { provider, systemPrompt: 'portability test', dispatch: undefined };
  const defs: Array<[string, Record<string, unknown>]> = [
    // (a)/(d)/(e): a cwd-relative fs root hint + a shell that runs in the caller cwd.
    ['port-rel', { fs: { root: 'proj' }, shell: { allowCommands: ['pwd', 'touch'] }, dispatch: false }],
    // (b): alias into the GLOBAL allowed-root map.
    ['port-alias', { fs: { root: 'shared' }, shell: false, dispatch: false }],
    // (c): multi-root.
    ['port-multi', { fs: { roots: ['a', 'b'] }, shell: false, dispatch: false }],
  ];
  for (const [name, nativeTooling] of defs) {
    const created = await host.callJson('agent_create', {
      name,
      provider: base.provider,
      systemPrompt: base.systemPrompt,
      nativeTooling,
    });
    expect(created['_isError'], JSON.stringify(created)).toBeUndefined();
  }
}, 120_000);

afterAll(async () => {
  await host?.close();
  await llm?.stop();
  for (const d of [scratch, tmpRoot, homeRoot]) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
  // eslint-disable-next-line no-console
  console.log(
    '\n48dc PORTABILITY MATRIX (cwd × case → outcome)\n' +
      results.map(([c, k, o]) => `  ${c.padEnd(12)} ${k.padEnd(34)} ${o}`).join('\n')
  );
});

/** Run one scripted task from `cwd` through the real server; returns task JSON. */
async function runCase(
  agent: string,
  caseId: string,
  cwd: string,
  turns: ScriptedCall[][]
): Promise<Record<string, unknown>> {
  llm.setScript(caseId, turns);
  const out = await host.callJson('task', {
    agent_name: agent,
    prompt: `CASE:${caseId} go`,
    cwd,
  });
  expect(out['_isError'], JSON.stringify(out)).toBeUndefined();
  expect(out['status'], JSON.stringify(out)).toBe('completed');
  return out;
}

const DENIED = /outside|not allowed|denied|allowed director|access denied|permission/i;
const fsCall = (tool: string, args: Record<string, unknown>): ScriptedCall => ({
  server: 'fs',
  tool,
  args,
});
const shCall = (command: string[]): ScriptedCall => ({
  server: 'shell',
  tool: 'shell_execute',
  args: { command },
});

describe('48dc-PORT agent portability across caller cwds (real built agent-mcp over MCP stdio)', () => {
  it('48dc-PORT AC3: srt is NOT on the server PATH, yet the server discovers it (sandbox not silently disabled)', () => {
    expect(srtOnPath(host.path), 'precondition: srt must be absent from the launch PATH').toBe(false);
    // The per-run policy the server provisioned is the pinned override file.
    const policy = JSON.parse(fs.readFileSync(host.srtSettingsPath, 'utf8')) as {
      filesystem: { allowWrite: string[] };
    };
    expect(Array.isArray(policy.filesystem.allowWrite)).toBe(true);
  });

  // QA covering set (c9f0a791 AC7): which cases run against which cwd.
  const COVERING: Record<string, string[]> = {
    space: ['a', 'e'],
    'home-nontmp': ['a', 'b', 'c', 'e', 'f'],
  };
  for (const idx of [0, 1]) {
    const label = ['space', 'home-nontmp'][idx] ?? '';
    const covers = (c: string) => COVERING[label]?.includes(c) ?? false;
    const f = () => fixtures[idx] as CwdFixture;
    const rec = (k: string, o: string) => results.push([label, k, o]);

    if (covers('a')) it(`c9f0a791 AC7 / 48dc-PORT AC1/AC2 [${label}] (a) cwd-relative fs root hint: create/write/read land under <cwd>/proj`, async () => {
      const target = path.join(f().cwd, 'proj', 'sub', 'rel.txt');
      await runCase('port-rel', `rel-${idx}`, f().cwd, [
        [fsCall('create_directory', { path: path.join(f().cwd, 'proj', 'sub') })],
        [fsCall('write_file', { path: target, content: f().token })],
        [fsCall('read_text_file', { path: target })],
      ]);
      expect(fs.readFileSync(target, 'utf8')).toBe(f().token);
      expect(llm.resultsFor(`rel-${idx}`).join('\n')).toContain(f().token);
      rec('(a) relative root', 'PASS bytes@cwd/proj');
    }, 300_000);

    if (covers('e')) it(`c9f0a791 AC7 / 48dc-PORT AC1/AC2 [${label}] (e) + 99cb14a7/7e854708 AC6 (d) explicit fs.root, caller cwd elsewhere: shell pwd == caller cwd and it can WRITE there`, async () => {
      const marker = path.join(f().cwd, 'shell-wrote.txt');
      await runCase('port-rel', `shell-${idx}`, f().cwd, [
        [shCall(['pwd'])],
        [shCall(['touch', 'shell-wrote.txt'])],
      ]);
      expect(llm.resultsFor(`shell-${idx}`)[0]).toContain(f().cwd);
      // Bytes on disk: the shell's cwd IS the caller cwd, and srt let it write.
      expect(fs.existsSync(marker), `shell could not write ${marker} — srt allowWrite misses the caller cwd`).toBe(true);
      const policy = JSON.parse(fs.readFileSync(host.srtSettingsPath, 'utf8')) as {
        filesystem: { allowWrite: string[] };
      };
      // Only a cwd OUTSIDE os.tmpdir() depends on `callerCwdRoots` to be in the policy;
      // the tmpdir-resident `space` cwd is covered by the static list, so this case
      // isolates whitespace quoting and stays green when that branch regresses (AC7).
      if (f().nonTmp) expect(policy.filesystem.allowWrite).toContain(f().cwd);
      rec('(d/e) shell pwd + write', 'PASS pwd=cwd, wrote');
    }, 300_000);

    if (covers('b')) it(`c9f0a791 AC7 / 48dc-PORT AC1/AC2 [${label}] (b) alias root from the global allowed-root map ignores the caller cwd`, async () => {
      const target = path.join(shared, `alias-${idx}.txt`);
      await runCase('port-alias', `alias-${idx}`, f().cwd, [
        [
          fsCall('write_file', { path: target, content: f().token }),
          fsCall('write_file', { path: path.join(f().cwd, 'alias-cwd.txt'), content: 'nope' }),
        ],
      ]);
      expect(fs.readFileSync(target, 'utf8')).toBe(f().token);
      expect(fs.existsSync(path.join(f().cwd, 'alias-cwd.txt'))).toBe(false);
      expect(llm.resultsFor(`alias-${idx}`).join('\n')).toMatch(DENIED);
      rec('(b) alias root', 'PASS bytes@alias, cwd DENIED');
    }, 300_000);

    if (covers('c')) it(`c9f0a791 AC7 / 48dc-PORT AC1/AC2 [${label}] (c) multi-root {roots:[a,b]}: both writable, sibling <cwd>/c denied`, async () => {
      await runCase('port-multi', `multi-${idx}`, f().cwd, [
        [
          fsCall('write_file', { path: path.join(f().cwd, 'a', 'm.txt'), content: `A${f().token}` }),
          fsCall('write_file', { path: path.join(f().cwd, 'b', 'm.txt'), content: `B${f().token}` }),
          fsCall('write_file', { path: path.join(f().cwd, 'c', 'm.txt'), content: 'nope' }),
        ],
      ]);
      expect(fs.readFileSync(path.join(f().cwd, 'a', 'm.txt'), 'utf8')).toBe(`A${f().token}`);
      expect(fs.readFileSync(path.join(f().cwd, 'b', 'm.txt'), 'utf8')).toBe(`B${f().token}`);
      expect(fs.existsSync(path.join(f().cwd, 'c', 'm.txt'))).toBe(false);
      rec('(c) multi-root', 'PASS a,b written; c DENIED');
    }, 300_000);

    if (covers('f')) it(`c9f0a791 AC7 / 48dc-PORT AC1/AC2 [${label}] (f) outside-root read/write DENIED (no bytes leak, none written)`, async () => {
      const turns: ScriptedCall[] = [
        fsCall('write_file', { path: path.join(f().cwd, 'notproj.txt'), content: 'nope' }),
        fsCall('write_file', { path: path.join(f().outside, 'leak.txt'), content: 'nope' }),
        fsCall('read_text_file', { path: path.join(f().outside, 'secret.txt') }),
        // Folded from the former standalone case (AC7): a SHELL write outside the
        // caller cwd must be blocked by srt itself (non-tmp cwd) — sandbox active.
        shCall(['touch', path.join(f().outside, 'shell-leak.txt')]),
      ];
      await runCase('port-rel', `deny-${idx}`, f().cwd, [turns]);
      expect(
        fs.existsSync(path.join(f().outside, 'shell-leak.txt')),
        'srt must deny a shell write outside the allowed roots'
      ).toBe(false);
      expect(fs.existsSync(path.join(f().cwd, 'notproj.txt'))).toBe(false);
      expect(fs.existsSync(path.join(f().outside, 'leak.txt'))).toBe(false);
      const fed = llm.resultsFor(`deny-${idx}`).join('\n');
      expect(fed).toMatch(DENIED);
      expect(fed).not.toContain(f().secret);
      rec('(f) outside denied (fs)', 'DENIED, nothing written/leaked');
    }, 300_000);
  }

  it('c9f0a791 AC4: with a fake `npx` first on PATH, fs + shell tasks complete and npx is NEVER invoked', async () => {
    // Teeth: the shim really is what `npx` resolves to on the server's PATH
    // (a marker + exit 99), so an absent marker below means no spawn reached it.
    const probe = spawnSync('sh', ['-c', 'npx --version'], { env: { PATH: host.path } });
    expect(probe.status).toBe(99);
    expect(fs.existsSync(npxShim.marker), 'shim must record a direct invocation').toBe(true);
    fs.rmSync(npxShim.marker, { force: true });

    const f = fixtures[1] as CwdFixture;
    const target = path.join(f.cwd, 'proj', 'ac4.txt');
    await runCase('port-rel', 'ac4-npx', f.cwd, [
      [fsCall('write_file', { path: target, content: f.token })],
      [shCall(['pwd'])],
    ]);
    expect(fs.readFileSync(target, 'utf8')).toBe(f.token);
    expect(fs.existsSync(npxShim.marker), 'npx was invoked by a builtin spawn').toBe(false);
  }, 300_000);
});
