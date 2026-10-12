/**
 * R5-WEB-SIMPLE AC2 — default egress is OPEN via the allow-all loopback proxy; any operator
 * restriction keeps srt's own domain filter. Policy-file rendering + the proxy's own behaviour
 * (loopback sockets only; the real-srt/real-server proof is `web-fetch-curl.e2e.test.ts`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationalEnv } from '../config.js';
import { startOpenEgressProxy, type OpenEgressProxy } from '../egress-proxy.js';
import {
  DEFAULT_SRT_ALLOWED_DOMAINS,
  SRT_SETTINGS_ENV,
  addRunSrtAllowWrite,
  addRunSrtReadOnlyDir,
  defaultSrtDenyRead,
  provisionRunSrtPolicy,
  provisionSrtPolicy,
  removeRunSrtPolicy,
  type SrtSettings,
} from '../srt-policy.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-simple-egress-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const policy = (name: string, opts: Parameters<typeof provisionSrtPolicy>[0] = {}) =>
  provisionSrtPolicy({ settingsPath: join(dir, name), applySandboxExtras: true, extraAllowWrite: [], extraAllowWriteRoots: [], spillReadDir: null, ...opts });

describe('R5-WEB-SIMPLE AC2 egress mode rendering', () => {
  it('R5-WEB-SIMPLE AC2: the shipped config default is empty (open egress)', () => {
    expect(operationalEnv.config.agent.shell.sandbox.allowedDomains).toEqual([]);
  });

  it('R5-WEB-SIMPLE AC2: with a proxy port and no operator domains the policy is OPEN and keeps credential denies', () => {
    const r = policy('open.json', { openEgressProxyPort: 45678 });
    expect(r.egress).toEqual({ mode: 'open', proxyPort: 45678 });
    expect(r.settings.network?.httpProxyPort).toBe(45678);
    expect(r.settings.network?.allowedDomains).toEqual([...DEFAULT_SRT_ALLOWED_DOMAINS]);
    for (const d of defaultSrtDenyRead()) expect(r.settings.filesystem?.denyRead).toContain(d);
  });

  it('R5-WEB-SIMPLE AC2 negative control: no proxy port => restricted, no httpProxyPort (the previous PyPI-only default)', () => {
    const r = policy('closed.json');
    expect(r.egress.mode).toBe('restricted');
    expect(r.settings.network?.httpProxyPort).toBeUndefined();
  });

  it('R5-WEB-SIMPLE AC2: an operator allowedDomains option wins over the open proxy', () => {
    const r = policy('opt-domains.json', { openEgressProxyPort: 45678, allowedDomains: ['api.example.com'] });
    expect(r.egress.mode).toBe('restricted');
    expect(r.settings.network?.httpProxyPort).toBeUndefined();
    expect(r.settings.network?.allowedDomains).toContain('api.example.com');
  });

  it('R5-WEB-SIMPLE AC2: an operator-pinned file with its own domains or its own httpProxyPort wins', () => {
    const domains = join(dir, 'pinned-domains.json');
    writeFileSync(domains, JSON.stringify({ network: { allowedDomains: ['corp.example'], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }));
    expect(provisionSrtPolicy({ settingsPath: domains, applySandboxExtras: true, openEgressProxyPort: 45678 }).egress.mode).toBe('restricted');

    const proxy = join(dir, 'pinned-proxy.json');
    writeFileSync(proxy, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [], httpProxyPort: 777 }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }));
    const r = provisionSrtPolicy({ settingsPath: proxy, applySandboxExtras: true, openEgressProxyPort: 45678 });
    expect(r.egress.mode).toBe('restricted');
    expect((JSON.parse(readFileSync(proxy, 'utf8')) as SrtSettings).network?.httpProxyPort).toBe(777);
  });

  it('R5-WEB-SIMPLE AC2: re-provisioning an open file keeps it open, and dropping the port later removes OUR port', () => {
    const f = 'reprov.json';
    expect(policy(f, { openEgressProxyPort: 45678 }).egress.mode).toBe('open');
    expect(policy(f, { openEgressProxyPort: 45678 }).egress.mode).toBe('open');
    const closed = policy(f);
    expect(closed.egress.mode).toBe('restricted');
    expect(closed.settings.network?.httpProxyPort).toBeUndefined();
  });
});

describe('R6-prep AC2: later re-provisions of the run policy keep the open-egress port (provisionSrtPolicy dependents)', () => {
  const runPolicy = (name: string, port?: number) => {
    const file = join(dir, name);
    const env = { [SRT_SETTINGS_ENV]: file } as NodeJS.ProcessEnv;
    const result = provisionRunSrtPolicy(join(dir, 'cwd'), env, undefined, port);
    return { file, result, port: () => (JSON.parse(readFileSync(file, 'utf8')) as SrtSettings).network?.httpProxyPort };
  };

  it('R6-prep AC2: provisionRunSrtPolicy with a port is open; addRunSrtAllowWrite and addRunSrtReadOnlyDir keep the port', () => {
    const r = runPolicy('run-open.json', 45679);
    try {
      expect(r.result.egress).toEqual({ mode: 'open', proxyPort: 45679 });
      addRunSrtAllowWrite([join(dir, 'second-root')]);
      expect(r.port()).toBe(45679);
      addRunSrtReadOnlyDir(join(dir, 'shim'));
      expect(r.port()).toBe(45679);
    } finally {
      removeRunSrtPolicy();
    }
  });

  it('R6-prep AC2 negative control: provisioned without a port the later re-provisions stay restricted (no httpProxyPort appears)', () => {
    const r = runPolicy('run-restricted.json');
    try {
      expect(r.result.egress.mode).toBe('restricted');
      addRunSrtAllowWrite([join(dir, 'another-root')]);
      addRunSrtReadOnlyDir(join(dir, 'shim2'));
      expect(r.port()).toBeUndefined();
    } finally {
      removeRunSrtPolicy();
    }
  });
});

describe('R5-WEB-SIMPLE AC2 open egress proxy', () => {
  let proxy: OpenEgressProxy;
  let web: Server;
  let webPort: number;
  beforeAll(async () => {
    proxy = await startOpenEgressProxy();
    web = createServer((_q, res) => res.end('WEB-BODY'));
    await new Promise<void>((ok) => web.listen(0, '127.0.0.1', ok));
    webPort = (web.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((ok) => web.close(() => ok()));
  });

  it('listens on loopback only', () => {
    const probe = net.connect(proxy.port, '127.0.0.1');
    return new Promise<void>((ok, bad) => {
      probe.once('connect', () => (probe.destroy(), ok()));
      probe.once('error', bad);
    });
  });

  it('forwards an absolute-form http GET', async () => {
    const body = await new Promise<string>((ok, bad) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${webPort}/`, headers: { host: `127.0.0.1:${webPort}` } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => ok(b));
      });
      req.on('error', bad);
      req.end();
    });
    expect(body).toBe('WEB-BODY');
  });

  it('tunnels CONNECT (the https path) end to end', async () => {
    const s = net.connect(proxy.port, '127.0.0.1');
    const got = await new Promise<string>((ok, bad) => {
      let buf = '';
      s.on('error', bad);
      s.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('WEB-BODY')) ok(buf);
      });
      s.write(`CONNECT 127.0.0.1:${webPort} HTTP/1.1\r\nHost: 127.0.0.1:${webPort}\r\n\r\n`);
      s.once('data', () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    });
    s.destroy();
    expect(got).toContain('200 Connection Established');
    expect(got).toContain('WEB-BODY');
  });

  it('destroys the client socket (no 502 body) when the upstream is unreachable, so curl exits non-zero', async () => {
    const unused = await new Promise<number>((ok) => {
      const t = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (t.address() as AddressInfo).port;
        t.close(() => ok(p));
      });
    });
    const s = net.connect(proxy.port, '127.0.0.1');
    const received: string[] = [];
    s.on('data', (d) => received.push(d.toString()));
    s.write(`CONNECT 127.0.0.1:${unused} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise<void>((ok) => s.once('close', () => ok()));
    expect(received.join('')).not.toContain('200');
    expect(received.join('')).not.toContain('502');
  });
});
