/**
 * Stray-writer guard (backlog c536ce29, TRC-AC16, segment S8A).
 *
 * Owner requirement: "All logs need to be correctly written to ~/.adhd in their
 * correctly namespaced locations." State/log files must be rooted at the
 * `@adhd/environment`-resolved paths, never at ad-hoc `os.tmpdir()` /
 * `os.homedir()` / hard-coded `.adhd` / `/tmp` / repo-relative `data` roots.
 *
 * This test statically scans the non-test source of `entrypoint/agent-mcp/src`
 * and `packages/agent/<pkg>/src` for filesystem-write call sites and path-root
 * escapes, and compares them with two explicit lists:
 *
 *  - ALLOWLIST: reviewed sites that are legitimate (each carries a reason).
 *  - KNOWN_VIOLATIONS: today's real offenders, each naming the later segment
 *    that fixes it. The test is green now, FAILS on any NEW site, and FAILS when
 *    a KNOWN_VIOLATIONS entry no longer exists (forcing its removal once fixed).
 *
 * A site is identified by `<repo-relative path> :: <trimmed code line>` (comments
 * and import statements are blanked first), so entries survive unrelated line
 * shifts but a changed offending line must be re-reviewed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url)); // entrypoint/agent-mcp/src/__tests__
const REPO_ROOT = join(here, '..', '..', '..', '..');

/** A reviewed site; `count` (default 1) is how many identical lines the file holds. */
interface IEntry {
  readonly key: string;
  readonly reason: string;
  readonly count?: number;
}

/** One detector: a name and the regex that flags a (comment/import-stripped) line. */
interface IDetector {
  readonly name: string;
  readonly pattern: RegExp;
}

const DETECTORS: readonly IDetector[] = [
  {
    name: 'fs-write-call',
    pattern:
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|createWriteStream|copyFile|copyFileSync|openSync|rename|renameSync)\s*\(/,
  },
  { name: 'os-tmpdir', pattern: /\btmpdir\s*\(/ },
  { name: 'os-homedir', pattern: /\bhomedir\s*\(/ },
  { name: 'adhd-literal', pattern: /['"`]\.adhd['"`]/ },
  { name: 'tmp-literal', pattern: /['"`](?:\/private)?\/tmp\b/ },
  { name: 'cwd-data-root', pattern: /process\.cwd\(\)[^\n]*['"`]data['"`]/ },
];

/** A flagged source line. */
interface ISite {
  readonly file: string;
  readonly line: number;
  readonly detectors: readonly string[];
  /** Stable identity: `<file> :: <trimmed code>`. */
  readonly key: string;
}

/**
 * Blank comments and import/export-from statements, preserving every newline
 * so line numbers stay valid. String/template literals are kept intact.
 */
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

/** Scan one file's text; `file` is only used to build site keys. */
export function scanSource(file: string, src: string): ISite[] {
  const lines = stripNonCode(src).split('\n');
  const sites: ISite[] = [];
  lines.forEach((text, idx) => {
    const hits = DETECTORS.filter((d) => d.pattern.test(text)).map((d) => d.name);
    if (hits.length === 0) return;
    sites.push({
      file,
      line: idx + 1,
      detectors: hits,
      key: `${file} :: ${text.trim().replace(/\s+/g, ' ')}`,
    });
  });
  return sites;
}

function countKeys(sites: readonly ISite[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s.key, (m.get(s.key) ?? 0) + 1);
  return m;
}

function isScannable(name: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) &&
    !/\.d\.ts$/.test(name) &&
    !/\.(?:test|spec|e2e|fixture)\.|\.e2e\.(?:ts|js)$/.test(name)
  );
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (['__tests__', 'test', 'node_modules', 'dist'].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (isScannable(name)) acc.push(full);
  }
  return acc;
}

function scanRealSource(): ISite[] {
  const roots = [join(REPO_ROOT, 'entrypoint', 'agent-mcp', 'src')];
  const pkgDir = join(REPO_ROOT, 'packages', 'agent');
  for (const pkg of readdirSync(pkgDir).sort()) {
    const src = join(pkgDir, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      /* package without src/ */
    }
  }
  const sites: ISite[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      sites.push(...scanSource(rel, readFileSync(file, 'utf8')));
    }
  }
  return sites;
}

/**
 * Reviewed, legitimate sites. Each is deliberately NOT a log/state writer into a
 * stray root: user-config installers, read-only lookups, the environment-resolved
 * DB open, explicit-outDir CLI codegen, or sandbox deny/allow lists.
 */
const ALLOWLIST: readonly IEntry[] = [
  { key: 'entrypoint/agent-mcp/src/db/client.ts :: fs.mkdirSync(directory, {', reason: 'parent dir of the environment-resolved DB path' },
  { key: 'entrypoint/agent-mcp/src/db/migrate-legacy.ts :: const effectiveHome = home ?? process.env[\'HOME\'] ?? os.homedir();', reason: 'read-only legacy DB migration source lookup' },
  { key: 'entrypoint/agent-mcp/src/db/migrate-legacy.ts :: return path.join(effectiveHome, ".adhd", "agent-mcp", "agents.db");', reason: 'read-only legacy DB migration source (pre-environment layout)' },
  { key: 'entrypoint/agent-mcp/src/scripts/tail-db-path.ts :: export function legacyTailDbPath(home: string = os.homedir()): string {', reason: 'read-only: names the pre-cascade DB path in the tail hint (never written)' },
  { key: 'entrypoint/agent-mcp/src/scripts/tail-db-path.ts :: return path.join(home, ".adhd", "agent-mcp", "agents.db");', reason: 'read-only: names the pre-cascade DB path in the tail hint (never written)' },
  { key: 'entrypoint/agent-mcp/src/install.ts :: mkdirSync(dirname(path), { recursive: true });', reason: 'install: user MCP client config writer' },
  { key: 'entrypoint/agent-mcp/src/install.ts :: writeFileSync(path, JSON.stringify(doc, null, 2) + \'\\n\', \'utf8\');', reason: 'install: user MCP client config writer' },
  { key: 'entrypoint/agent-mcp/src/install.ts :: const home = homeOverride ?? homedir();', count: 3, reason: 'install: locates client config files (test-overridable home)' },
  { key: 'entrypoint/agent-mcp/src/install.ts :: mkdirSync(dirname(configPath), { recursive: true });', reason: 'install: user config writer' },
  { key: 'entrypoint/agent-mcp/src/install.ts :: writeFileSync(configPath, updated, \'utf8\');', reason: 'install: user config writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: const home = homedir();', count: 2, reason: 'sandbox deny/allow path lists, not writes' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: tmpdir(),', reason: 'sandbox allow-write list entry, not a writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });', reason: 'lock file beside the srt policy dir (follows the srt settings path, which is under the namespaced temp root)' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: fd = openSync(lockPath, \'wx\');', reason: 'O_EXCL lock beside the srt policy dir' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: return join(homedir(), \'.srt-settings.json\');', reason: 'third-party srt tool settings file (fixed location owned by srt)' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: mkdirSync(dirname(path), { recursive: true, mode: 0o700 });', reason: 'srt settings atomic write' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: fd = openSync(file, \'wx\', 0o600);', reason: 'srt settings atomic write: O_EXCL 0600 tmp file (BK7 515a2b50 SEC-F8)' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: home: string = homedir(),', count: 2, reason: 'injectable home for extraAllowWrite / spill-read-dir validation (BK7 515a2b50, BK9 3ad735bb), not a writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: return validateSrtSpillReadDir(spill.dir, homedir(), defaultSrtDenyRead(), {', reason: 'sandbox allowRead validation input for the tool-result spill dir (BK9 3ad735bb), not a writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: return foldPath(join(home, \'.adhd\'));', reason: 'protected-root comparison (adhdHomeFold) shared by the sandbox extraAllowWrite validator (BK7 515a2b50) and the spill read-dir validator (9ed453c1 HARD-H3), not a writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: const backlogFold = foldPath(join(home, \'.adhd\', \'backlog\'));', reason: 'allowlist root for the sandbox extraAllowWrite validator (BK7 515a2b50), not a writer' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: export function defaultSrtDenyWrite(home: string = homedir()): string[] {', reason: 'sandbox denyWrite path list, not a writer (BK7 515a2b50)' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: return validateSrtExtraAllowWrite(configured ?? DEFAULT_SRT_EXTRA_ALLOW_WRITE, homedir(), defaultSrtDenyRead(), {', reason: 'sandbox allow-write validation input, not a writer (BK7 515a2b50)' },
  { key: 'entrypoint/agent-mcp/src/srt-policy.ts :: renameSync(tmp, path);', reason: 'srt settings atomic write' },
  { key: 'entrypoint/agent-mcp/src/utils/load-env.ts :: dotenvConfig({ path: path.join(os.homedir(), ".adhd", ".env"), quiet: true });', reason: 'read-only .env hierarchy' },
  { key: 'entrypoint/agent-mcp/src/utils/load-env.ts :: dotenvConfig({ path: path.join(cwd, ".adhd", ".env"), override: true, quiet: true });', reason: 'read-only .env hierarchy' },
  { key: 'entrypoint/agent-mcp/src/utils/load-env.ts :: const ENV_FILE_SEGMENTS = [".adhd", ".env"] as const;', reason: 'read-only .env hierarchy (de046157 store-path rule reads, never writes)' },
  { key: 'entrypoint/agent-mcp/src/utils/load-env.ts :: const homeFile = ENV_FILE(os.homedir());', reason: 'read-only .env hierarchy (de046157 store-path rule reads, never writes)' },
  { key: 'packages/agent/agent-core-env/src/open-registry-db.ts :: fs.mkdirSync(directory, { recursive: true });', reason: 'parent dir of the caller-supplied (environment-resolved) DB path' },
  { key: 'packages/agent/agent-core-env/src/open-registry-store.ts :: fs.mkdirSync(directory, { recursive: true });', reason: 'parent dir of the caller-supplied (environment-resolved) DB path' },
  { key: 'packages/agent/agent-engine-compiler/src/cli/compile.ts :: fs.mkdirSync(parent, { recursive: true });', reason: 'compile CLI: explicit user --out-dir' },
  { key: 'packages/agent/agent-engine-compiler/src/cli/compile.ts :: fs.mkdirSync(args.outDir, { recursive: true });', reason: 'compile CLI: explicit user --out-dir' },
  { key: 'packages/agent/agent-engine-compiler/src/cli/compile.ts :: fs.writeFileSync(dest, content, \'utf8\');', reason: 'compile CLI: explicit user --out-dir' },
  { key: 'packages/agent/agent-engine-orchestrator/src/plugins/loader.ts :: const nested = resolve(process.cwd(), \'.adhd\', \'agent-mcp\', \'config.json\');', reason: 'read-only config lookup' },
  { key: 'packages/agent/agent-engine-orchestrator/src/plugins/loader.ts :: const globalAdhd = resolve(homedir(), \'.adhd\', \'agent-mcp\', \'config.json\');', reason: 'read-only config lookup' },
  { key: 'packages/agent/agent-engine-orchestrator/src/plugins/loader.ts :: const globalLegacy = resolve(homedir(), \'.agent-mcp\', \'config.json\');', reason: 'read-only legacy config lookup' },
  { key: 'packages/agent/agent-engine-orchestrator/src/engine/tool-result-spill.ts :: mkdirSync(dir, { recursive, mode: 0o700 });', reason: 'BK9 3ad735bb opt-in tool-result spill: the dir is the Environment-resolved <temp>/tool-results (config.ts resolveToolResultSpill) or an operator-set ABSOLUTE agent.toolResult.spill.dir; created 0700, symlinks refused' },
  { key: 'packages/agent/agent-engine-orchestrator/src/engine/tool-result-spill.ts :: fd = openSync(file, flags, 0o600);', reason: 'BK9 3ad735bb spill file: O_EXCL|O_NOFOLLOW 0600 under the validated spill dir' },
  { key: 'packages/agent/agent-engine-orchestrator/src/engine/tool-result-spill.ts :: closeSync(openSync(join(dir, SPILL_ROOT_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600));', reason: '9ed453c1 BLIND F1: empty root marker claiming the validated spill dir (O_EXCL|O_NOFOLLOW 0600)' },
  { key: 'packages/agent/agent-engine-orchestrator/src/engine/tool-result-spill.ts :: const fd = openSync(join(taskDir, SPILL_TASK_MARKER), constants.O_WRONLY | constants.O_CREAT | O_NOFOLLOW, 0o600);', reason: '9ed453c1 BLIND F1/F2: empty task marker inside the spill task dir, refreshed (futimes) on every spill; O_NOFOLLOW 0600' },
  { key: 'packages/agent/agent-engine-orchestrator/src/engine/tool-result-spill.ts :: const fd = openSync(dir, constants.O_RDONLY | O_NOFOLLOW);', reason: 'BK9 3ad735bb: read-only fd on the verified spill dir to fchmod it to 0700, not a writer' },
  { key: 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts :: await mkdir(root, { recursive: true, mode: 0o700 });', reason: 'claudecli: creates the host-injected namespaced temp root (wire.tempDir)' },
  { key: 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts :: await writeFile(filePath, JSON.stringify({ mcpServers: mapped }), { encoding: "utf8", mode: 0o600 });', reason: 'claudecli: mcp-config written under the namespaced temp root' },
  { key: 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts :: const dir = await mkdtemp(join(await this.ensureTempRoot(), "agent-mcp-spec-"));', reason: 'claudecli: spec dir under the namespaced temp root' },
  { key: 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts :: await mkdir(agentsDir, { recursive: true, mode: 0o700 });', reason: 'claudecli: inside the temp-root spec dir' },
  { key: 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts :: await writeFile(join(agentsDir, safeFile), content, { encoding: "utf8", mode: 0o600 });', reason: 'claudecli: inside the temp-root spec dir' },
];

/**
 * Today's real stray writers. Each names the segment that fixes it; the entry must
 * be deleted in that segment (TRC-AC16-c enforces this).
 */
const KNOWN_VIOLATIONS: readonly (IEntry & { readonly fixedBy: string })[] = [];

describe('c536ce29 TRC-AC16 stray-writer guard', () => {
  it('TRC-AC16-a: flags a planted stray writer and passes clean source (negative control)', () => {
    const planted = [
      "import { writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      '// writeFileSync("/tmp/in-a-comment-is-ignored")',
      'export function leak(): void {',
      "  writeFileSync(`${tmpdir()}/agent-mcp.log`, 'x');",
      '}',
    ].join('\n');
    const sites = scanSource('fixture/planted.ts', planted);
    expect(sites.map((s) => s.line)).toEqual([5]);
    expect(sites[0].detectors).toEqual(expect.arrayContaining(['fs-write-call', 'os-tmpdir']));

    const planted2 = scanSource('fixture/p2.ts', "const p = join(h, '.adhd', 'x');\nconst q = '/tmp/x';\n");
    expect(planted2.map((s) => s.detectors[0])).toEqual(['adhd-literal', 'tmp-literal']);

    const clean = [
      "import { writeFileSync } from 'node:fs';",
      "import { Environment } from '@adhd/environment';",
      '/* mkdirSync("/tmp") in a block comment */',
      'export function ok(env: Environment): string {',
      '  return env.paths.logs;',
      '}',
    ].join('\n');
    expect(scanSource('fixture/clean.ts', clean)).toEqual([]);
  });

  it('TRC-AC16-b: real source flags exactly ALLOWLIST + KNOWN_VIOLATIONS (no more, no fewer)', () => {
    const found = countKeys(scanRealSource());
    const expected = new Map<string, number>();
    for (const e of [...ALLOWLIST, ...KNOWN_VIOLATIONS]) expected.set(e.key, (expected.get(e.key) ?? 0) + (e.count ?? 1));
    const unexpected = [...found].filter(([k, n]) => n > (expected.get(k) ?? 0)).map(([k]) => k).sort();
    expect(unexpected, 'NEW stray writer(s): route through @adhd/environment paths or review into ALLOWLIST').toEqual([]);
    const missing = [...expected].filter(([k, n]) => (found.get(k) ?? 0) < n).map(([k]) => k).sort();
    expect(missing, 'stale ALLOWLIST/KNOWN_VIOLATIONS entry: remove it').toEqual([]);
  });

  it('TRC-AC16-b: a NEW identical-line duplicate of a reviewed site is also caught (count teeth)', () => {
    const one = countKeys(scanSource('f.ts', 'const a = homedir();\n'));
    const two = countKeys(scanSource('f.ts', 'const a = homedir();\nconst a = homedir();\n'));
    expect([...one.values()]).toEqual([1]);
    expect([...two.values()]).toEqual([2]);
  });

  it('TRC-AC16-c: a stale KNOWN_VIOLATIONS entry is detected as failing', () => {
    const found = countKeys(scanRealSource());
    const withStale = [...KNOWN_VIOLATIONS.map((k) => k.key), 'packages/agent/gone/src/x.ts :: writeFileSync(p, d)'];
    expect(withStale.filter((k) => !found.has(k))).toEqual(['packages/agent/gone/src/x.ts :: writeFileSync(p, d)']);
    // and the real list has none stale
    expect(KNOWN_VIOLATIONS.map((k) => k.key).filter((k) => !found.has(k))).toEqual([]);
    for (const k of KNOWN_VIOLATIONS) expect(k.fixedBy).toMatch(/^(S8B|P1)\b/);
  });

  it('dump (informational): lists current sites when STRAY_DUMP=1', () => {
    if (process.env['STRAY_DUMP'] !== '1') return;
    for (const s of scanRealSource()) console.log(`SITE ${s.key}`);
  });
});

describe('c536ce29 S8B-AC1 stray-writer guard keeps its teeth', () => {
  it('c536ce29 S8B-AC1: KNOWN_VIOLATIONS is empty, the claudecli OS-tmpdir fallback is gone, and a re-introduced one is detected', () => {
    expect(KNOWN_VIOLATIONS).toEqual([]);
    const fixed = 'const root = this.config.wire?.tempDir;\n';
    expect(scanSource('packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts', fixed)).toEqual([]);
    const regressed = 'const root = this.config.wire?.tempDir ?? tmpdir();\n';
    const sites = scanSource('packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts', regressed);
    expect(sites.map((s) => s.detectors)).toEqual([['os-tmpdir']]);
  });

  it('c536ce29 S8B-AC1: the scattered writers fixed in S8B are no longer detected, and a re-introduced raw writer is', () => {
    const fixedTail = 'const dbPath = resolveTailDbPath();\n';
    expect(scanSource('entrypoint/agent-mcp/src/scripts/agent-mcp-tail.ts', fixedTail)).toEqual([]);
    const fixedSrt = "export function srtRunPolicyDir(roots) {\n  return join(roots.temp, 'srt');\n}\n";
    expect(scanSource('entrypoint/agent-mcp/src/srt-policy.ts', fixedSrt)).toEqual([]);
    const regressed = "export function srtRunPolicyDir() {\n  return join(homedir(), '.adhd', 'agent-mcp', 'srt');\n}\n";
    const sites = scanSource('entrypoint/agent-mcp/src/srt-policy.ts', regressed);
    expect(sites.map((s) => s.detectors)).toEqual([expect.arrayContaining(['os-homedir', 'adhd-literal'])]);
  });
});
