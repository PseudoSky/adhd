/**
 * Client-side `web_fetch` tool (R6B-web AC2).
 *
 * Anthropic's `web_fetch_20250910` is a SERVER tool: the API request carries only a type tag and
 * Anthropic fetches the page. A provider that cannot take server tools (the `claudecli` provider
 * reaches tools only through the loopback MCP bridge; OpenAI-compatible providers have no such
 * tag) therefore had no web fetch at all. This module is the engine-executed equivalent: ONE tool
 * definition ({@link WEB_FETCH_TOOL}) and ONE executor ({@link executeWebFetch}) that any provider
 * can use, advertised through the normal registry so every governance seam (permission gate,
 * allowlists, argument coercion, result cap) applies exactly as for an MCP tool.
 *
 * The result mirrors the shape the model sees from Anthropic's tool (PROVEN from the R6 C1 api
 * log): `{type:'web_fetch_result', url, retrieved_at, content:{type:'document', source:{type:
 * 'text', media_type:'text/plain', data}, title}}` where `data` is a frontmatter block (`---`,
 * selected `meta-*` lines, `title:`, `---`) followed by the page text.
 *
 * Constraints live in the tool description (no extra machinery): http/https only, text only, body
 * capped at {@link WEB_FETCH_MAX_BYTES} with an explicit truncation marker.
 *
 * Egress safety (bc799330): the tool runs in the HOST process, outside the shell sandbox, so it owns
 * its own SSRF defence. Every hop (the first request and each redirect) is resolved exactly once,
 * EVERY returned address is classified, and a destination that is loopback, RFC1918, link-local,
 * unspecified, unique-local, shared-address, multicast or reserved (including the IPv4-mapped,
 * NAT64 and 6to4 spellings of those) is refused in both open and allow-listed mode; an allow-listed
 * NAME that resolves to such an address is refused too. The connection is then made to the
 * validated IP itself (`node:http`/`node:https` with `host: <ip>`, `servername`/`Host` kept as the
 * original name), so there is no second resolution a DNS-rebinding answer could win.
 *
 * Extraction safety (cbad68d4): {@link extractHtml} is a set of forward-only scanners, not unbounded
 * lazy regexes, so cost is linear in the page size on untrusted input.
 */
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { InProcessToolDescriptor } from '../clients/in-process.js';
import type { IMcpClient } from '../clients/types.js';
import type { ToolDefinition } from '../providers/types.js';

/** Server (route) name under which the tool is advertised: `web__web_fetch` / `mcp__web__web_fetch`. */
export const WEB_FETCH_SERVER = 'web';

/** Max response body bytes read from the network. */
export const WEB_FETCH_MAX_BYTES = 1_000_000;

/** Max characters of extracted text returned to the model before the truncation marker. */
export const WEB_FETCH_MAX_TEXT_CHARS = 100_000;

/** Appended to the text when either cap is hit. */
export const WEB_FETCH_TRUNCATION_MARKER = '\n\n[web_fetch: content truncated]';

/**
 * The single shared definition. Both the registry advertisement and the byte-identity test read
 * this constant; there is no second copy of the description or schema anywhere.
 */
export const WEB_FETCH_TOOL: InProcessToolDescriptor = Object.freeze({
  name: 'web_fetch',
  description:
    'Fetch a web page by URL and return its text. Only http and https URLs are allowed. ' +
    'The result holds the final url, a title, selected meta tags and the page text with markup removed; ' +
    'binary content is refused and long pages end with "[web_fetch: content truncated]".',
  inputSchema: Object.freeze({
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The absolute http or https URL to fetch.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  }) as Record<string, unknown>,
});

/** The tool as a registry `ToolDefinition` (what `listAllTools` advertises, with the server prefix). */
export function webFetchAdvertised(): ToolDefinition {
  return {
    name: `${WEB_FETCH_SERVER}__${WEB_FETCH_TOOL.name}`,
    description: WEB_FETCH_TOOL.description,
    inputSchema: WEB_FETCH_TOOL.inputSchema,
  };
}

/** One resolved address of a host. */
export interface IResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to ALL of its addresses (the DNS seam; defaults to `dns.lookup(all)`). */
export type WebFetchResolver = (hostname: string) => Promise<ReadonlyArray<IResolvedAddress>>;

/**
 * The socket seam: `node:http(s).request`. Receives `protocol` in its options so one function serves
 * both schemes. Defaults to the real `http`/`https` request functions.
 */
export type WebFetchRequestFn = (options: RequestOptions & { protocol: string; servername?: string }) => ClientRequest;

export interface WebFetchOptions {
  /**
   * Egress allow-list (srt-style: exact host or `*.suffix`). Undefined => open egress, the same
   * "open" mode the shell sandbox runs in when no restriction is configured. Private, loopback and
   * link-local destinations are refused in BOTH modes: the allow-list narrows names, it never
   * authorises an internal address.
   */
  allowedDomains?: readonly string[];
  /**
   * @deprecated Ignored. A fetch implementation resolves the name again on its own, which defeats
   * the validated-IP pin, so the executor connects through {@link WebFetchOptions.request} instead.
   * The field remains only so existing callers (the registry forwards the wire-traced fetch) still
   * type-check.
   */
  fetchImpl?: typeof fetch;
  /** DNS seam, called once per hop. Defaults to `dns.promises.lookup(host, { all: true, verbatim: true })`. */
  resolve?: WebFetchResolver;
  /** Socket seam (tests). Defaults to `node:http` / `node:https` `request`. */
  request?: WebFetchRequestFn;
  /** Wall-clock source for `retrieved_at`. */
  now?: () => Date;
  signal?: AbortSignal;
}

/** srt-style host match: exact host, or `*.suffix` matches any subdomain (not the bare suffix). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((raw) => {
    const d = raw.toLowerCase().replace(/:\d+$/, '');
    if (d.startsWith('*.')) return h.endsWith(d.slice(1)) && h.length > d.length - 1;
    return h === d;
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// ---------------------------------------------------------------------------------------------
// HTML extraction (cbad68d4): forward-only scanners. Every pattern is searched with a cursor that
// only moves forward, and a search that found nothing (or found its closer) is remembered, so an
// unterminated opener can never trigger a rescan to end-of-input per opener.
// ---------------------------------------------------------------------------------------------

/** Work counter for {@link extractHtml}: characters the scanners advanced over (deterministic, not wall-clock). */
export interface IExtractStats {
  scanned: number;
}

/** Diagnostic switches of {@link extractHtml}. */
export interface IExtractOptions {
  /**
   * Remember where a search found nothing (or found its match) and reuse that for later, further-right
   * queries. Default `true`. `false` reproduces the cost of the former lazy regexes (every unterminated
   * opener rescans to end-of-input) so a test can prove the linear bound is not vacuous.
   */
  memoize?: boolean;
}

/** Forward-only searcher for `re` (global) over `text`; see {@link IExtractOptions.memoize}. */
class ForwardSearch {
  private from = -1;
  private hit: { index: number; end: number } | undefined;

  constructor(
    private readonly re: RegExp,
    private readonly text: string,
    private readonly stats: IExtractStats,
    private readonly memoize: boolean
  ) {}

  /** First match at or after `from`, or undefined. `from` must not decrease between calls for the memo to apply. */
  next(from: number): { index: number; end: number } | undefined {
    if (this.memoize && this.from >= 0 && from >= this.from) {
      if (!this.hit) return undefined; // nothing from `this.from` on, so nothing from a later start either
      if (this.hit.index >= from) return this.hit; // first match after `this.from` is also first after `from`
    }
    this.re.lastIndex = from;
    const m = this.re.exec(this.text);
    this.hit = m ? { index: m.index, end: m.index + m[0].length } : undefined;
    this.from = from;
    this.stats.scanned += (this.hit ? this.hit.end : this.text.length) - from;
    return this.hit;
  }
}

/** `text` with every `<!-- ... -->` replaced by a space; an unterminated `<!--` is left in place. */
function stripComments(text: string, stats: IExtractStats, memoize: boolean): string {
  const out: string[] = [];
  let copied = 0;
  let p = 0;
  for (;;) {
    const open = text.indexOf('<!--', p);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    stats.scanned += (close < 0 ? text.length : close + 3) - p;
    if (close < 0) {
      if (memoize) break; // no `-->` after this opener means none after any later one
      p = open + 4;
      continue;
    }
    out.push(text.slice(copied, open), ' ');
    copied = p = close + 3;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** `text` with every `<name ...> ... </name>` block (script/style/noscript/template/head/title) replaced by a space. */
function stripBlocks(text: string, stats: IExtractStats, memoize: boolean): string {
  const open = /<(script|style|noscript|template|head|title)\b/gi;
  const closers = new Map<string, ForwardSearch>();
  const out: string[] = [];
  let copied = 0;
  let p = 0;
  for (;;) {
    open.lastIndex = p;
    const m = open.exec(text);
    if (!m) {
      stats.scanned += text.length - p;
      break;
    }
    stats.scanned += m.index + m[0].length - p;
    const name = m[1]!.toLowerCase();
    let search = closers.get(name);
    if (!search) {
      search = new ForwardSearch(new RegExp(`</${name}\\s*>`, 'gi'), text, stats, memoize);
      closers.set(name, search);
    }
    const close = search.next(m.index + m[0].length);
    if (!close) {
      p = m.index + 1; // this opener is unterminated; a later, different block may still be complete
      continue;
    }
    out.push(text.slice(copied, m.index), ' ');
    copied = p = close.end;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** `text` with every `<...>` run (at least one non-`>` char between the brackets) replaced by a space. */
function stripTags(text: string, stats: IExtractStats, memoize: boolean): string {
  const out: string[] = [];
  let copied = 0;
  let p = 0;
  for (;;) {
    const lt = text.indexOf('<', p);
    if (lt < 0) break;
    const gt = text.indexOf('>', lt + 1);
    stats.scanned += (gt < 0 ? text.length : gt + 1) - p;
    if (gt < 0) {
      if (memoize) break; // no `>` after this `<` means none after any later `<`
      p = lt + 1;
      continue;
    }
    if (gt === lt + 1) {
      p = lt + 1; // `<>`: the tag needs at least one character
      continue;
    }
    out.push(text.slice(copied, lt), ' ');
    copied = p = gt + 1;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** First `<title ...> ... </title>` text of `html`, raw; '' when there is none. */
function titleText(html: string, stats: IExtractStats, memoize: boolean): string {
  const open = /<title\b/gi;
  const m = open.exec(html);
  if (!m) {
    stats.scanned += html.length;
    return '';
  }
  const gt = html.indexOf('>', m.index + m[0].length);
  if (gt < 0) {
    stats.scanned += html.length;
    return '';
  }
  const close = new ForwardSearch(/<\/title>/gi, html, stats, memoize).next(gt + 1);
  stats.scanned += gt + 1;
  return close ? html.slice(gt + 1, close.index) : '';
}

/** The `content` of the FIRST `<meta name=NAME content=...>` per requested name, in one pass over the tags. */
function metaContents(html: string, names: readonly string[], stats: IExtractStats, memoize: boolean): Map<string, string> {
  const found = new Map<string, string>();
  const open = /<meta\b/gi;
  let p = 0;
  while (found.size < names.length) {
    open.lastIndex = p;
    const m = open.exec(html);
    if (!m) {
      stats.scanned += html.length - p;
      break;
    }
    const gt = html.indexOf('>', m.index + m[0].length);
    stats.scanned += (gt < 0 ? html.length : gt + 1) - p;
    if (gt < 0) {
      if (memoize) break; // no `>` after this opener means none after any later one
      p = m.index + 1;
      continue;
    }
    const tag = html.slice(m.index, gt + 1);
    p = gt + 1;
    stats.scanned += tag.length;
    const n = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (n === undefined || !names.includes(n) || found.has(n)) continue;
    const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (c !== undefined) found.set(n, decodeEntities(c).trim());
  }
  return found;
}

/**
 * Title, selected meta and tag-stripped text of an HTML document. Pure, and linear in
 * `html.length` for any input (see {@link IExtractStats}).
 *
 * @param html    the page source (callers cap it at {@link WEB_FETCH_MAX_BYTES})
 * @param stats   optional work counter, incremented as the scanners advance
 * @param options diagnostic switches, see {@link IExtractOptions}
 */
export function extractHtml(
  html: string,
  stats: IExtractStats = { scanned: 0 },
  options: IExtractOptions = {}
): { title: string; meta: Array<[string, string]>; text: string } {
  const memoize = options.memoize !== false;
  const title = decodeEntities(titleText(html, stats, memoize)).replace(/\s+/g, ' ').trim();
  const meta: Array<[string, string]> = [];
  const found = metaContents(html, ['viewport', 'description'], stats, memoize);
  for (const name of ['viewport', 'description']) {
    const v = found.get(name);
    if (v) meta.push([`meta-${name}`, v]);
  }
  stats.scanned += html.length;
  const breaks = stripBlocks(stripComments(html, stats, memoize), stats, memoize).replace(
    /<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|pre|blockquote)\s*>|<br\s*\/?>/gi,
    '\n'
  );
  const body = stripTags(breaks, stats, memoize);
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n')
    .trim();
  return { title, meta, text };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      chunks.push(value.subarray(0, value.length - (size - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// ---------------------------------------------------------------------------------------------
// Address classification (bc799330): which destinations the tool refuses to connect to.
// ---------------------------------------------------------------------------------------------

type V4 = readonly [number, number, number, number];

function parseIPv4(s: string): V4 | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (o.some((n) => !(n >= 0 && n <= 255))) return undefined;
  return o as unknown as V4;
}

/** Eight 16-bit groups of an IPv6 address (already known to satisfy `isIPv6`). */
function parseIPv6(addr: string): number[] | undefined {
  let s = addr;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':') + 1;
    const v4 = parseIPv4(s.slice(cut));
    if (!v4) return undefined;
    s = `${s.slice(0, cut)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const all = halves.length === 2 ? [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail] : head;
  return all.length === 8 && all.every((g) => Number.isInteger(g)) ? all : undefined;
}

function classifyV4(o: V4): string | undefined {
  const [a, b] = o;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private (RFC1918)';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'shared-address (CGNAT)';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return undefined;
}

/**
 * The address class `ip` belongs to when it is NOT a public destination, else `undefined`.
 * Covers loopback, unspecified, RFC1918, link-local, shared-address (CGNAT), multicast, reserved,
 * IPv6 unique-local (fc00::/7), site-local and the IPv4-mapped / IPv4-compatible / NAT64 / 6to4
 * spellings of any of those (reported as e.g. `IPv4-mapped loopback`). Pure.
 *
 * @param ip an IPv4 or IPv6 literal, without URL brackets
 */
export function classifyAddress(ip: string): string | undefined {
  const family = isIP(ip);
  if (family === 4) {
    const v4 = parseIPv4(ip);
    return v4 ? classifyV4(v4) : 'malformed';
  }
  if (family !== 6) return 'malformed';
  const g = parseIPv6(ip);
  if (!g) return 'malformed';
  const embedded = (hi: number, lo: number, label: string): string | undefined => {
    const c = classifyV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
    return c ? `${label} ${c}` : undefined;
  };
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return 'unspecified';
  if (zeros(0, 7) && g[7] === 1) return 'loopback';
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!, 'IPv4-mapped');
  if (zeros(0, 6)) return embedded(g[6]!, g[7]!, 'IPv4-compatible');
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded(g[6]!, g[7]!, 'NAT64');
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!, '6to4');
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique-local (ULA)';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  return undefined;
}

const defaultResolve: WebFetchResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/**
 * Resolve `url`'s host ONCE and return the address to connect to, refusing the hop when ANY
 * returned address is non-public (a name that answers with a mix is still refused: the connection
 * must not be able to land on the private one). An IP-literal host skips DNS but is classified.
 */
async function resolveEgressTarget(url: URL, resolve: WebFetchResolver): Promise<IResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  const addrs: ReadonlyArray<IResolvedAddress> = literal
    ? [{ address: host, family: literal === 6 ? 6 : 4 }]
    : await resolve(host);
  if (addrs.length === 0) throw new Error(`web_fetch: ${host} did not resolve to any address`);
  for (const a of addrs) {
    const cls = classifyAddress(a.address);
    if (cls) {
      throw new Error(
        `web_fetch: egress denied: ${host}${literal ? '' : ` resolves to ${a.address}, which`} is a ${cls} address ` +
          '(loopback, private, link-local and other internal destinations are refused)'
      );
    }
  }
  return addrs[0]!;
}

/** Idle-socket timeout of one request, so a silent server cannot hold the shared event loop's tool slot forever. */
export const WEB_FETCH_IDLE_TIMEOUT_MS = 30_000;

/**
 * `res` as a web `ReadableStream`, with back-pressure and a cancel that destroys the socket.
 * Hand-rolled instead of `Readable.toWeb` because that adapter can enqueue a chunk that was already
 * buffered when the consumer cancelled (a redirect hop or an unsupported content type cancels the
 * body at once), which throws "Controller is already closed" as an UNCAUGHT exception in the host.
 */
function bodyStream(res: IncomingMessage): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on('data', (chunk: Buffer) => {
        if (closed) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) <= 0) res.pause();
      });
      res.on('end', () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      res.on('error', (e: Error) => {
        if (closed) return;
        closed = true;
        controller.error(e);
      });
      res.on('close', () => {
        if (closed) return;
        closed = true;
        controller.error(new Error('web_fetch: connection closed before the response completed'));
      });
    },
    pull() {
      res.resume();
    },
    cancel() {
      closed = true;
      res.destroy();
    },
  });
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const defaultRequest: WebFetchRequestFn = (o) => (o.protocol === 'https:' ? httpsRequest(o) : httpRequest(o));

/**
 * One GET to `url`, connected to `target.address` (the validated IP) with the original name kept in
 * the `Host` header and, for https, in `servername` (SNI + certificate verification). Redirects are
 * NOT followed. The `IncomingMessage` is wrapped in a standard `Response` so body reading and
 * content-type handling stay shared.
 */
function pinnedGet(url: URL, target: IResolvedAddress, request: WebFetchRequestFn, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolveResponse, reject) => {
    const hostLiteral = url.hostname.replace(/^\[|\]$/g, '');
    const defaultPort = url.protocol === 'https:' ? 443 : 80;
    const req = request({
      protocol: url.protocol,
      host: target.address,
      family: target.family,
      port: url.port !== '' ? Number(url.port) : defaultPort,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        accept: 'text/html,text/plain,*/*;q=0.5',
        'accept-encoding': 'identity',
        'user-agent': 'agent-mcp-web-fetch',
      },
      ...(url.protocol === 'https:' && !isIP(hostLiteral) ? { servername: hostLiteral } : {}),
      agent: false,
      timeout: WEB_FETCH_IDLE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    req.once('timeout', () => req.destroy(new Error(`web_fetch: no data from ${url.host} for ${WEB_FETCH_IDLE_TIMEOUT_MS}ms`)));
    req.once('error', reject);
    req.once('response', (res: IncomingMessage) => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 502;
        const body = NULL_BODY_STATUS.has(status) ? null : bodyStream(res);
        if (body === null) res.resume();
        resolveResponse(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
      } catch (e) {
        res.destroy();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.end();
  });
}

/**
 * Fetch `args.url` and return the Anthropic-shaped `web_fetch_result`.
 * Throws a plain `Error` (surfaced to the model as an `isError` result) on bad input, a denied
 * host, a host that is or resolves to a non-public address, a non-2xx status or a non-text content type.
 */
export async function executeWebFetch(args: unknown, opts: WebFetchOptions = {}): Promise<Record<string, unknown>> {
  const raw = (args as { url?: unknown } | null)?.url;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('web_fetch: "url" (string) is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`web_fetch: not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web_fetch: only http and https URLs are allowed (got ${url.protocol})`);
  }
  const allowed = opts.allowedDomains;
  const checkHost = (u: URL): void => {
    if (allowed && !hostAllowed(u.hostname, allowed)) {
      throw new Error(`web_fetch: egress denied: ${u.hostname} is not in the allowed domains`);
    }
  };
  const resolve = opts.resolve ?? defaultResolve;
  const request = opts.request ?? defaultRequest;

  // Follow redirects manually so every hop is held to the egress policy: allow-list, then a single
  // resolution whose every address must be public, then a connection to that validated address.
  let res: Response | undefined;
  for (let hop = 0; hop <= 5; hop += 1) {
    checkHost(url);
    const target = await resolveEgressTarget(url, resolve);
    res = await pinnedGet(url, target, request, opts.signal);
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    await res.body?.cancel().catch(() => undefined);
    if (hop === 5) throw new Error('web_fetch: too many redirects');
    url = new URL(loc, url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`web_fetch: redirect to a non-http URL refused (${url.protocol})`);
    }
  }
  if (!res) throw new Error('web_fetch: no response');
  if (!res.ok) throw new Error(`web_fetch: HTTP ${res.status} ${res.statusText}`.trim());

  const ctype = (res.headers.get('content-type') ?? 'text/plain').toLowerCase();
  const isHtml = /html|xml/.test(ctype);
  if (!isHtml && !/^text\/|json|javascript/.test(ctype)) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`web_fetch: unsupported content type ${ctype} (text only)`);
  }
  const body = await readCapped(res, WEB_FETCH_MAX_BYTES);
  let title = '';
  let meta: Array<[string, string]> = [];
  let text = body.text;
  if (isHtml) ({ title, meta, text } = extractHtml(body.text));

  let truncated = body.truncated;
  if (text.length > WEB_FETCH_MAX_TEXT_CHARS) {
    text = text.slice(0, WEB_FETCH_MAX_TEXT_CHARS);
    truncated = true;
  }
  const front = ['---', ...meta.map(([k, v]) => `${k}: ${v}`), ...(title ? [`title: ${title}`] : []), '---'].join('\n');
  const data = `${front}\n\n${text}${truncated ? WEB_FETCH_TRUNCATION_MARKER : ''}`;
  return {
    type: 'web_fetch_result',
    url: url.toString(),
    retrieved_at: (opts.now?.() ?? new Date()).toISOString(),
    content: {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data },
      title,
    },
  };
}

/** Engine-native MCP client for the `web` server: one tool, executed in this process. */
export class WebFetchClient implements IMcpClient {
  constructor(private readonly opts: Omit<WebFetchOptions, 'signal'> = {}) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [{ name: WEB_FETCH_TOOL.name, description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema }];
  }

  async callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (toolName !== WEB_FETCH_TOOL.name) throw new Error(`Unknown tool '${toolName}' on server '${WEB_FETCH_SERVER}'`);
    return executeWebFetch(args, { ...this.opts, signal });
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
