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
 */
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

export interface WebFetchOptions {
  /**
   * Egress allow-list (srt-style: exact host or `*.suffix`). Undefined => open egress, the same
   * "open" mode the shell sandbox runs in when no restriction is configured.
   */
  allowedDomains?: readonly string[];
  /** Injected fetch (tests / wire-traced seam). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
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

function metaContent(html: string, name: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const n = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (n?.toLowerCase() !== name) continue;
    const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (c !== undefined) return decodeEntities(c).trim();
  }
  return undefined;
}

/** Title, selected meta and tag-stripped text of an HTML document. Pure. */
export function extractHtml(html: string): { title: string; meta: Array<[string, string]>; text: string } {
  const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const meta: Array<[string, string]> = [];
  for (const name of ['viewport', 'description']) {
    const v = metaContent(html, name);
    if (v) meta.push([`meta-${name}`, v]);
  }
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|pre|blockquote)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
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

/**
 * Fetch `args.url` and return the Anthropic-shaped `web_fetch_result`.
 * Throws a plain `Error` (surfaced to the model as an `isError` result) on bad input, a denied
 * host, a non-2xx status or a non-text content type.
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
  checkHost(url);

  const doFetch = opts.fetchImpl ?? fetch;
  // Follow redirects manually so every hop is held to the egress policy.
  let res: Response | undefined;
  for (let hop = 0; hop <= 5; hop += 1) {
    res = await doFetch(url, {
      redirect: 'manual',
      signal: opts.signal,
      headers: { accept: 'text/html,text/plain,*/*;q=0.5', 'user-agent': 'agent-mcp-web-fetch' },
    });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    await res.body?.cancel().catch(() => undefined);
    if (hop === 5) throw new Error('web_fetch: too many redirects');
    url = new URL(loc, url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`web_fetch: redirect to a non-http URL refused (${url.protocol})`);
    }
    checkHost(url);
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
