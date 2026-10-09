/**
 * Egress-site guard (backlog c536ce29, TRC-AC16).
 *
 * Owner requirement: "every api call that agent mcp makes needs to be logged raw". That holds only
 * while EVERY outbound call goes through the `EngineConfig.wire` seams. This test statically scans
 * the non-test source of `entrypoint/agent-mcp/src` and `packages/agent/agent-engine-orchestrator/src`
 * and FAILS when it finds, outside the sanctioned wrapper sites:
 *
 *  - a raw `fetch(` or `globalThis.fetch`
 *  - a raw `child_process` call (`spawn`/`exec`/`execFile`/`fork` and their sync forms)
 *  - an MCP client transport construction (the Stdio / StreamableHTTP / SSE client transports)
 *    that is not matched by a `wrapMcpTransport(` call in the same file
 *  - an `OpenAI`/`Anthropic` SDK client construction that is not matched by a `sdkFetchOption(` spread
 *
 * Sanctioned fallbacks live in ONE helper (`providers/wire.ts`) and in the wrappers themselves
 * (`wire/`). Every other exception is in ALLOWLIST with a reason; a stale entry also FAILS, so the
 * list cannot rot. Teeth: the detectors are run against synthetic violating sources below, and the
 * real scan was proven red by reintroducing a raw call (see the commit message).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const SCAN_ROOTS = ['entrypoint/agent-mcp/src', 'packages/agent/agent-engine-orchestrator/src'];

interface IDetector {
  readonly name: string;
  readonly pattern: RegExp;
}

const DETECTORS: readonly IDetector[] = [
  { name: 'raw-fetch', pattern: /(?<![\w.$])fetch\s*\(|\bglobalThis\.fetch\b/ },
  {
    name: 'raw-child-process',
    pattern: /(?<![\w.$])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
  },
];
// Built from parts: this file only scans for transports, it must never read as constructing one.
const TRANSPORT_KINDS = ['Stdio', 'StreamableHTTP', 'SSE'].map((k) => `${k}ClientTransport`);
const TRANSPORT_CTOR = new RegExp(`new\\s+(?:${TRANSPORT_KINDS.join('|')})\\s*\\(`, 'g');
const SDK_CTOR = /new\s+(?:OpenAI|Anthropic)\s*\(/g;

/** Directories whose files ARE the wrappers (they take the raw primitive on purpose). */
const SANCTIONED_DIRS: readonly string[] = ['entrypoint/agent-mcp/src/wire/'];
/** The single fallback helper for the engine. */
const SANCTIONED_FILES: readonly string[] = ['packages/agent/agent-engine-orchestrator/src/providers/wire.ts'];

interface IEntry {
  readonly key: string;
  readonly reason: string;
}

/** Reviewed exceptions: `<repo-relative path> :: <trimmed code line>`. */
/** Empty: the pricing feed fetch is routed through the wire seam (c536ce29 TRC-AC7). */
const ALLOWLIST: readonly IEntry[] = [];

export function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
        }
        if (quote !== '`' && src[i] === '\n') break;
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  // Blank import / re-export statements (multi-line safe) but keep newlines.
  return out.replace(
    /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"\n]+['"];?|^[ \t]*import\s*['"][^'"\n]+['"];?/gm,
    (m) => m.replace(/[^\n]/g, ' '),
  );
}

export interface ISite {
  readonly file: string;
  readonly line: number;
  readonly detectors: readonly string[];
  readonly key: string;
}

/** Scan one file's text for raw-egress sites. */
export function scanSource(file: string, src: string): ISite[] {
  const lines = stripNonCode(src).split('\n');
  const sites: ISite[] = [];
  lines.forEach((text, idx) => {
    const hits = DETECTORS.filter((d) => d.pattern.test(text)).map((d) => d.name);
    if (hits.length === 0) return;
    sites.push({ file, line: idx + 1, detectors: hits, key: `${file} :: ${text.trim().replace(/\s+/g, ' ')}` });
  });
  return sites;
}

/** Files where a construction count exceeds the count of its sanctioned wrapping call. */
export function unwrappedConstructions(src: string): string[] {
  const code = stripNonCode(src);
  const out: string[] = [];
  const count = (re: RegExp): number => (code.match(re) ?? []).length;
  if (count(TRANSPORT_CTOR) > count(/\bwrapMcpTransport\s*\(/g)) out.push('mcp-transport-not-wrapped');
  if (count(SDK_CTOR) > count(/\bsdkFetchOption\s*\(/g)) out.push('sdk-client-without-fetch-seam');
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (['__tests__', 'test', 'node_modules', 'dist'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(?:test|spec|e2e)\./.test(name)) acc.push(full);
  }
  return acc;
}

const sanctioned = (rel: string): boolean =>
  SANCTIONED_FILES.includes(rel) || SANCTIONED_DIRS.some((d) => rel.startsWith(d));

function scanRepo(): { sites: ISite[]; unwrapped: Array<{ file: string; problem: string }> } {
  const sites: ISite[] = [];
  const unwrapped: Array<{ file: string; problem: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, abs).split(sep).join('/');
      const src = readFileSync(abs, 'utf8');
      if (!sanctioned(rel)) {
        sites.push(...scanSource(rel, src));
        for (const problem of unwrappedConstructions(src)) unwrapped.push({ file: rel, problem });
      }
    }
  }
  return { sites, unwrapped };
}

describe('c536ce29 TRC-AC16 egress-site guard', () => {
  it('c536ce29 TRC-AC16: no raw fetch / child_process call outside the sanctioned wrapper sites', () => {
    const { sites } = scanRepo();
    const allowed = new Set(ALLOWLIST.map((e) => e.key));
    const unexpected = sites.filter((s) => !allowed.has(s.key));
    expect(
      unexpected.map((s) => `${s.file}:${s.line} [${s.detectors.join(',')}] ${s.key.split(' :: ')[1]}`),
      'route this egress through EngineConfig.wire (providers/wire.ts) or add a reviewed ALLOWLIST entry'
    ).toEqual([]);
    const present = new Set(sites.map((s) => s.key));
    expect(ALLOWLIST.filter((e) => !present.has(e.key)).map((e) => e.key), 'stale ALLOWLIST entries').toEqual([]);
  });

  it('c536ce29 TRC-AC16: every MCP client transport and provider SDK client is built through its wire seam', () => {
    expect(scanRepo().unwrapped).toEqual([]);
  });

  it('c536ce29 TRC-AC16: the detectors have teeth - synthetic violations are flagged, comments and wrapped calls are not', () => {
    const bad = [
      'const r = await fetch(url);',
      'const r = globalThis.fetch(url, init);',
      'const p = spawn("claude", args);',
      'execFileSync("git", ["status"]);',
      'const c = fork("./child.js");',
    ];
    for (const line of bad) expect(scanSource('x.ts', line), line).toHaveLength(1);
    expect(unwrappedConstructions(`const t = new ${TRANSPORT_KINDS[0]}({});`)).toEqual(['mcp-transport-not-wrapped']);
    expect(unwrappedConstructions(`const t = new ${TRANSPORT_KINDS[2]}(u); client.connect(wrapMcpTransport(c, t, m));`)).toEqual([]);
    expect(unwrappedConstructions('new OpenAI({ apiKey })')).toEqual(['sdk-client-without-fetch-seam']);
    expect(unwrappedConstructions('new Anthropic({ ...sdkFetchOption(cfg) })')).toEqual([]);
    const fine = [
      '// fetch(url) in a comment',
      'wireFetch(config)(input, init);',
      'wireSpawn(this.config)("claude", args);',
      'db.exec("PRAGMA x");',
      '/^a/.exec(text);',
      'this.spawn(cmd);',
    ];
    for (const line of fine) expect(scanSource('x.ts', line), line).toHaveLength(0);
  });
});
