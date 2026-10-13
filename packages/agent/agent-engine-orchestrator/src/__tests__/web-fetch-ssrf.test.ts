/**
 * Engine-native `web_fetch` egress safety (backlog bc799330, SSRF). Every title carries
 * `bc799330 AC<n>` using the ids stored on the item:
 *
 *   AC1  a URL whose host is or resolves to loopback / RFC1918 / link-local / unspecified / ULA (and the
 *        IPv4-mapped spellings of those) is refused in BOTH open and allow-listed mode, as a normal tool error
 *        that names the address class
 *   AC2  the connection goes to the validated resolved IP (one resolution per hop, no second one) and every
 *        redirect hop is re-validated
 *   AC3  an allow-listed NAME that resolves to a private address is refused
 *   AC5  ordinary public pages behave exactly as before
 *
 * AC6 (adapters) is in web-fetch-adapters.test.ts. No network, no DNS, no sleeps: the resolver and the socket
 * function are injected (fixtures/web-fetch-net.ts). Negative controls (validation removed => these go red) are
 * run by the dispatch harness against this file; see the return block of dispatch 48dc.
 */
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TRUNCATION_MARKER, classifyAddress, executeWebFetch } from '../tools/web-fetch.js';
import { PUBLIC_IP, stubNet } from './fixtures/web-fetch-net.js';

const page = (html = '<title>t</title><p>hello</p>') => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

/** A refusal must be a normal Error, name the class, and never reach the socket. */
async function expectRefused(url: string, cls: RegExp, opts: { allowedDomains?: string[]; dns?: Record<string, string[]> } = {}) {
  const net = stubNet(async () => page(), opts.dns);
  await expect(
    executeWebFetch({ url }, { ...net, ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}) })
  ).rejects.toThrow(cls);
  expect(net.requests, `no connection may be made for ${url}`).toHaveLength(0);
}

const LITERALS: Array<[url: string, cls: RegExp]> = [
  ['http://127.0.0.1/', /loopback/],
  ['http://127.255.255.254:8080/x', /loopback/],
  ['http://127.1/', /loopback/], // WHATWG URL normalises to 127.0.0.1
  ['http://2130706433/', /loopback/], // decimal form of 127.0.0.1
  ['http://0x7f.0.0.1/', /loopback/],
  ['http://[::1]/', /loopback/],
  ['http://10.0.0.1/', /private \(RFC1918\)/],
  ['http://172.16.0.1/', /private \(RFC1918\)/],
  ['http://172.31.255.255/', /private \(RFC1918\)/],
  ['http://192.168.1.1/', /private \(RFC1918\)/],
  ['http://169.254.169.254/latest/meta-data/', /link-local/],
  ['http://[fe80::1]/', /link-local/],
  ['http://[febf::1]/', /link-local/],
  ['http://0.0.0.0/', /unspecified/],
  ['http://[::]/', /unspecified/],
  ['http://[fc00::1]/', /unique-local \(ULA\)/],
  ['http://[fd12:3456:789a::1]/', /unique-local \(ULA\)/],
  ['http://[::ffff:127.0.0.1]/', /IPv4-mapped loopback/],
  ['http://[::ffff:7f00:1]/', /IPv4-mapped loopback/],
  ['http://[::ffff:169.254.169.254]/', /IPv4-mapped link-local/],
  ['http://[::ffff:a00:1]/', /IPv4-mapped private \(RFC1918\)/],
  ['http://[::ffff:c0a8:101]/', /IPv4-mapped private \(RFC1918\)/],
  ['http://[64:ff9b::7f00:1]/', /NAT64 loopback/],
  ['http://[2002:a9fe:a9fe::1]/', /6to4 link-local/],
  ['http://100.100.100.200/', /shared-address/],
  ['http://224.0.0.1/', /multicast/],
  ['http://255.255.255.255/', /reserved/],
];

describe('bc799330 AC1: non-public destinations are refused, naming the address class', () => {
  it.each(LITERALS)('bc799330 AC1: open mode refuses %s', async (url, cls) => {
    await expectRefused(url, cls);
  });

  it.each(LITERALS)('bc799330 AC1: restricted mode refuses %s even when the allow-list names it', async (url, cls) => {
    const host = new URL(url).hostname;
    await expectRefused(url, cls, { allowedDomains: [host.replace(/^\[|\]$/g, ''), host, '*'] });
  });

  it('bc799330 AC1: the refusal is a normal Error whose message names the host and the class', async () => {
    const net = stubNet(async () => page());
    const err = await executeWebFetch({ url: 'http://169.254.169.254/latest/meta-data/' }, net).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'web_fetch: egress denied: 169.254.169.254 is a link-local address (loopback, private, link-local and other internal destinations are refused)'
    );
  });

  it.each([
    ['internal.example', '10.1.2.3', /resolves to 10\.1\.2\.3, which is a private \(RFC1918\) address/],
    ['metadata.example', '169.254.169.254', /link-local/],
    ['local.example', '127.0.0.1', /loopback/],
    ['v6.example', '::1', /loopback/],
    ['v6ula.example', 'fd00::5', /unique-local \(ULA\)/],
    ['mapped.example', '::ffff:10.0.0.1', /IPv4-mapped private \(RFC1918\)/],
    ['zero.example', '0.0.0.0', /unspecified/],
  ])('bc799330 AC1: a name (%s) that RESOLVES to %s is refused in open mode', async (host, ip, cls) => {
    await expectRefused(`http://${host}/`, cls, { dns: { [host]: [ip] } });
  });

  it('bc799330 AC1: a name that answers with a public AND a private address is refused (the connection could land on either)', async () => {
    await expectRefused('http://mixed.example/', /127\.0\.0\.1.*loopback/, { dns: { 'mixed.example': [PUBLIC_IP, '127.0.0.1'] } });
    await expectRefused('http://mixed2.example/', /10\.0\.0\.9/, { dns: { 'mixed2.example': ['10.0.0.9', PUBLIC_IP] } });
  });

  it('bc799330 AC1: a name that resolves to nothing is refused', async () => {
    await expectRefused('http://empty.example/', /did not resolve to any address/, { dns: { 'empty.example': [] } });
  });

  it('bc799330 AC1: classifyAddress boundaries - the neighbours of each private range stay public', () => {
    for (const ip of ['172.15.255.255', '172.32.0.0', '169.253.255.255', '169.255.0.0', '11.0.0.0', '9.255.255.255', '192.167.255.255', '192.169.0.0', '126.255.255.255', '128.0.0.0', '100.63.255.255', '100.128.0.0', '8.8.8.8', '93.184.216.34', '223.255.255.255']) {
      expect(classifyAddress(ip), ip).toBeUndefined();
    }
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', 'fbff::1', '2a00::1']) {
      expect(classifyAddress(ip), ip).toBeUndefined();
    }
    expect(classifyAddress('172.16.0.0')).toBe('private (RFC1918)');
    expect(classifyAddress('172.31.255.255')).toBe('private (RFC1918)');
    expect(classifyAddress('fe80::1%eth0')).toBe('link-local');
    expect(classifyAddress('fec0::1')).toBe('site-local');
    expect(classifyAddress('not-an-ip')).toBe('malformed');
  });
});

describe('bc799330 AC2: the connection is pinned to the validated IP and every hop is re-validated', () => {
  it('bc799330 AC2: connects to the resolved public IP with the original name as Host (and as SNI for https)', async () => {
    const net = stubNet(async () => page(), { 'docs.example.com': ['203.0.113.7'] });
    await executeWebFetch({ url: 'https://docs.example.com:8443/a/b?q=1' }, net);
    expect(net.resolved).toEqual(['docs.example.com']);
    expect(net.requests).toHaveLength(1);
    const o = net.requests[0]!;
    expect(o.host).toBe('203.0.113.7');
    expect(o.family).toBe(4);
    expect(o.port).toBe(8443);
    expect(o.protocol).toBe('https:');
    expect(o.servername).toBe('docs.example.com');
    expect(o.path).toBe('/a/b?q=1');
    expect((o.headers as Record<string, string>)['host']).toBe('docs.example.com:8443');
    expect(o.agent).toBe(false);
  });

  it('bc799330 AC2: plain http gets default port 80 and no servername; an IPv6 answer is connected unbracketed with family 6', async () => {
    const net = stubNet(async () => page(), { 'v6.example.com': ['2606:4700:4700::1111'] });
    await executeWebFetch({ url: 'http://v6.example.com/' }, net);
    const o = net.requests[0]!;
    expect(o.host).toBe('2606:4700:4700::1111');
    expect(o.family).toBe(6);
    expect(o.port).toBe(80);
    expect(o.servername).toBeUndefined();
  });

  it('bc799330 AC2: DNS rebinding - a resolver that answers public first and private afterwards is asked ONCE, so the private answer is never seen', async () => {
    const net = stubNet(async () => page(), (_host, call) => (call === 1 ? ['203.0.113.7'] : ['127.0.0.1']));
    await executeWebFetch({ url: 'http://rebind.example.com/' }, net);
    expect(net.resolved).toEqual(['rebind.example.com']); // NEGATIVE CONTROL: a second lookup (the fetch() behaviour) makes this length 2
    expect(net.requests.map((r) => r.host)).toEqual(['203.0.113.7']);
  });

  it('bc799330 AC2: an IP-literal URL skips DNS entirely and is connected as given', async () => {
    const net = stubNet(async () => page());
    await executeWebFetch({ url: 'http://93.184.216.34/x' }, net);
    expect(net.resolved).toEqual([]);
    expect(net.requests[0]!.host).toBe('93.184.216.34');
  });

  it('bc799330 AC2: a redirect to a name that resolves private is refused, with exactly one connection made', async () => {
    const net = stubNet(
      async (url) => (url.hostname === 'start.example.com' ? new Response(null, { status: 302, headers: { location: 'http://sneaky.example.com/admin' } }) : page()),
      { 'sneaky.example.com': ['10.0.0.5'] }
    );
    await expect(executeWebFetch({ url: 'http://start.example.com/' }, net)).rejects.toThrow(/sneaky\.example\.com resolves to 10\.0\.0\.5, which is a private \(RFC1918\) address/);
    expect(net.resolved).toEqual(['start.example.com', 'sneaky.example.com']);
    expect(net.requests).toHaveLength(1);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', /link-local/],
    ['http://[::1]:9200/', /loopback/],
    ['http://127.0.0.1:6379/', /loopback/],
    ['http://[::ffff:7f00:1]/', /IPv4-mapped loopback/],
  ])('bc799330 AC2: a redirect to the literal %s is refused after one connection', async (location, cls) => {
    const net = stubNet(async () => new Response(null, { status: 301, headers: { location } }));
    await expect(executeWebFetch({ url: 'http://start.example.com/' }, net)).rejects.toThrow(cls);
    expect(net.requests).toHaveLength(1);
  });

  it('bc799330 AC2: a relative redirect re-validates (and re-resolves) the same host, then follows it to the page', async () => {
    const net = stubNet(async (url) => (url.pathname === '/old' ? new Response(null, { status: 302, headers: { location: '/new' } }) : page('<p>moved</p>')));
    const out = (await executeWebFetch({ url: 'http://ok.example.com/old' }, net)) as { url: string; content: { source: { data: string } } };
    expect(out.url).toBe('http://ok.example.com/new');
    expect(out.content.source.data).toContain('moved');
    expect(net.resolved).toEqual(['ok.example.com', 'ok.example.com']);
    expect(net.requests).toHaveLength(2);
  });

  it('bc799330 AC2: a redirect to a different PUBLIC name is followed and connected to ITS validated address', async () => {
    const net = stubNet(
      async (url) => (url.hostname === 'a.example.com' ? new Response(null, { status: 302, headers: { location: 'https://b.example.com/x' } }) : page()),
      { 'a.example.com': ['203.0.113.1'], 'b.example.com': ['203.0.113.2'] }
    );
    await executeWebFetch({ url: 'http://a.example.com/' }, net);
    expect(net.requests.map((r) => `${r.protocol}${r.host}`)).toEqual(['http:203.0.113.1', 'https:203.0.113.2']);
  });

  it('bc799330 AC2: more than five redirects is an error, not a loop', async () => {
    const net = stubNet(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(executeWebFetch({ url: 'http://loop.example.com/' }, net)).rejects.toThrow(/too many redirects/);
    expect(net.requests).toHaveLength(6);
  });
});

describe('bc799330 AC2: failover stays inside the validated addresses', () => {
  const V6 = '2606:4700:4700::1111';
  const V4 = '93.184.216.34';

  it('bc799330 AC2: an unreachable first address falls over to the next VALIDATED address with no second resolution', async () => {
    const net = stubNet(async () => page('<p>via v4</p>'), { 'dual.example.com': [V6, V4] }, { [V6]: 'ENETUNREACH' });
    const out = (await executeWebFetch({ url: 'http://dual.example.com/' }, net)) as { content: { source: { data: string } } };
    expect(out.content.source.data).toContain('via v4');
    expect(net.resolved).toEqual(['dual.example.com']);
    expect(net.requests.map((r) => r.host)).toEqual([V6, V4]);
  });

  it('bc799330 AC2: a PRIVATE sibling in the answer still refuses the hop before any connection (failover cannot reach it)', async () => {
    const net = stubNet(async () => page(), { 'dual.example.com': [V6, '10.0.0.1'] }, { [V6]: 'ENETUNREACH' });
    await expect(executeWebFetch({ url: 'http://dual.example.com/' }, net)).rejects.toThrow(/10\.0\.0\.1.*private/);
    expect(net.requests).toHaveLength(0);
  });

  it('bc799330 AC2: a non-connect failure (reset) is not retried on another address, and when every address fails the last error surfaces', async () => {
    const reset = stubNet(async () => page(), { 'dual.example.com': [V6, V4] }, { [V6]: 'ECONNRESET' });
    await expect(executeWebFetch({ url: 'http://dual.example.com/' }, reset)).rejects.toThrow(/ECONNRESET/);
    expect(reset.requests).toHaveLength(1);
    const all = stubNet(async () => page(), { 'dual.example.com': [V6, V4] }, { [V6]: 'ECONNREFUSED', [V4]: 'EHOSTUNREACH' });
    await expect(executeWebFetch({ url: 'http://dual.example.com/' }, all)).rejects.toThrow(/EHOSTUNREACH/);
    expect(all.requests).toHaveLength(2);
  });
});

describe('bc799330 AC3: the allow-list narrows names, it never authorises an internal address', () => {
  it('bc799330 AC3: an allow-listed hostname that resolves to a private address is refused (exact entry)', async () => {
    await expectRefused('https://intranet.corp.example/', /intranet\.corp\.example resolves to 192\.168\.0\.10, which is a private \(RFC1918\) address/, {
      allowedDomains: ['intranet.corp.example'],
      dns: { 'intranet.corp.example': ['192.168.0.10'] },
    });
  });

  it('bc799330 AC3: an allow-listed wildcard subdomain that resolves to loopback is refused', async () => {
    await expectRefused('https://app.corp.example/', /loopback/, { allowedDomains: ['*.corp.example'], dns: { 'app.corp.example': ['127.0.0.1'] } });
  });

  it('bc799330 AC3: an allow-listed name whose redirect target is allow-listed but resolves private is refused at the hop', async () => {
    const net = stubNet(
      async (url) => (url.hostname === 'www.corp.example' ? new Response(null, { status: 302, headers: { location: 'https://admin.corp.example/' } }) : page()),
      { 'admin.corp.example': ['fd00::1'] }
    );
    await expect(executeWebFetch({ url: 'https://www.corp.example/' }, { ...net, allowedDomains: ['*.corp.example'] })).rejects.toThrow(/unique-local \(ULA\)/);
    expect(net.requests).toHaveLength(1);
  });

  it('bc799330 AC3: the same allow-listed name resolving PUBLIC is fetched (control: the refusal is about the address, not the list)', async () => {
    const net = stubNet(async () => page('<p>public</p>'), { 'intranet.corp.example': ['203.0.113.50'] });
    const out = (await executeWebFetch({ url: 'https://intranet.corp.example/' }, { ...net, allowedDomains: ['intranet.corp.example'] })) as {
      content: { source: { data: string } };
    };
    expect(out.content.source.data).toContain('public');
    expect(net.requests[0]!.host).toBe('203.0.113.50');
  });

  it('bc799330 AC3: a name outside the allow-list is still denied before any DNS lookup', async () => {
    const net = stubNet(async () => page());
    await expect(executeWebFetch({ url: 'https://evil.example/' }, { ...net, allowedDomains: ['corp.example'] })).rejects.toThrow(/egress denied: evil\.example is not in the allowed domains/);
    expect(net.resolved).toEqual([]);
    expect(net.requests).toEqual([]);
  });
});

describe('bc799330 AC5: ordinary public pages are unaffected', () => {
  const HTML = '<html><head><title>Zipped</title></head><body><p>compressed body &amp; more</p></body></html>';
  const encoded = (enc: string, bytes: Buffer): Response => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': enc, 'content-length': String(bytes.length) } });
  const dataOf = async (r: Response): Promise<string> =>
    ((await executeWebFetch({ url: 'https://example.com/' }, stubNet(async () => r))) as { content: { source: { data: string } } }).content.source.data;

  it.each([
    ['gzip', (b: Buffer) => gzipSync(b)],
    ['x-gzip', (b: Buffer) => gzipSync(b)],
    ['deflate', (b: Buffer) => deflateSync(b)],
    ['br', (b: Buffer) => brotliCompressSync(b)],
  ])('bc799330 AC5: a %s-encoded page (the request advertises gzip, deflate, br as fetch did) is decoded to the same result as the plain page', async (enc, compress) => {
    const plain = await dataOf(page(HTML));
    expect(await dataOf(encoded(enc, compress(Buffer.from(HTML))))).toBe(plain);
    expect(plain).toContain('compressed body & more');
  });

  it('bc799330 AC5: an unsupported or corrupt content-encoding is a tool error, not garbage text', async () => {
    await expect(dataOf(encoded('zstd', Buffer.from(HTML)))).rejects.toThrow(/unsupported content-encoding zstd/);
    await expect(dataOf(encoded('gzip', Buffer.from('this is not gzip')))).rejects.toThrow();
  });

  it('bc799330 AC5: a compression bomb is bounded by the byte cap applied after decompression', async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61)); // 64 MiB of "a", tiny on the wire
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const data = await dataOf(new Response(bomb, { status: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } }));
    expect(data.endsWith(WEB_FETCH_TRUNCATION_MARKER)).toBe(true);
    expect(data.length).toBeLessThan(WEB_FETCH_MAX_BYTES);
  });

  it('bc799330 AC5: a public page resolves, connects, extracts and returns the Anthropic-shaped result', async () => {
    const net = stubNet(async () => page('<html><head><meta name="description" content="d &amp; e"><title>T</title></head><body><p>Body</p></body></html>'));
    const out = await executeWebFetch({ url: 'https://example.com/' }, { ...net, now: () => new Date('2026-10-13T00:00:00.000Z') });
    expect(out).toEqual({
      type: 'web_fetch_result',
      url: 'https://example.com/',
      retrieved_at: '2026-10-13T00:00:00.000Z',
      content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '---\nmeta-description: d & e\ntitle: T\n---\n\nBody' }, title: 'T' },
    });
  });

  it('bc799330 AC5: non-2xx, binary and 204 responses keep their prior outcomes', async () => {
    await expect(executeWebFetch({ url: 'http://a.example.com/' }, stubNet(async () => new Response('no', { status: 500, statusText: 'Boom' })))).rejects.toThrow(/HTTP 500 Boom/);
    await expect(
      executeWebFetch({ url: 'http://a.example.com/' }, stubNet(async () => new Response('x', { headers: { 'content-type': 'image/png' } })))
    ).rejects.toThrow(/unsupported content type image\/png/);
    const empty = (await executeWebFetch({ url: 'http://a.example.com/' }, stubNet(async () => new Response(null, { status: 204 })))) as { content: { source: { data: string } } };
    expect(empty.content.source.data).toBe('---\n---\n\n');
  });
});
