/**
 * R0.AC5 / R0.AC6 (25ce70b8 AC1, 1207765d) - e2e lane (ADR-0009).
 *
 * The CLI-parity instrument (`entrypoint/agent-mcp/parity/`) is a private measurement instrument and must never be published.
 * This suite proves it on the BUILT artifact, the way `npm publish` sees it:
 *   1. walking `dist/` finds no path containing `parity` and no file containing the `PARITY-INSTRUMENT-ONLY` marker;
 *   2. `npm pack --dry-run --json` in `dist/` lists no `parity` path;
 *   3. the structural guarantee holds in the source config (package.json `files`, tsconfig.lib.json `include`, project.json build/assets) and the
 *      published AGENTS.md / docs carry no instrument text;
 *   4. NEGATIVE CONTROL: a copy of dist with an injected `parity/x.mjs` (marker inside) turns BOTH the walker and the pack listing red.
 * Spawns `npm`, so it is e2e (isolated cwd under tmp/, fake HOME). Not env-gated.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DIST = path.join(PACKAGE_ROOT, 'dist');
const TMP = path.join(REPO_ROOT, 'tmp', 'agent-mcp', `parity-no-publish-${process.pid}`);
const MARKER = 'PARITY-INSTRUMENT-ONLY';

interface IScan {
  pathHits: string[];
  markerHits: string[];
  files: number;
}

/** Walk `root` (skipping node_modules): report every relative path containing `parity` and every file whose bytes contain the marker. */
function scan(root: string): IScan {
  const out: IScan = { pathHits: [], markerHits: [], files: 0 };
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (/parity/i.test(rel)) out.pathHits.push(rel);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) {
        out.files += 1;
        if (fs.readFileSync(abs).includes(MARKER)) out.markerHits.push(rel);
      }
    }
  };
  visit(root);
  return out;
}

/** The file list `npm pack` would publish from `cwd` (dry run; fake HOME so no real npm config or cache is read or written). */
function packList(cwd: string, home: string): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed (${r.status}): ${String(r.stderr).slice(0, 500)}`);
  const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

let fakeHome: string;

beforeAll(() => {
  // Loud, never a skip: the artifact under test must exist (the e2e target dependsOn builds it).
  if (!fs.existsSync(path.join(DIST, 'package.json')) || !fs.existsSync(path.join(DIST, 'src', 'index.js'))) {
    throw new Error(`built artifact missing: ${DIST} (run \`npx nx run agent-mcp:build\`); the no-publish proof needs the real dist`);
  }
  fakeHome = path.join(TMP, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('parity instrument is never published (R0.AC5, R0.AC6)', () => {
  it('dist/ contains no path with "parity" and no file with the PARITY-INSTRUMENT-ONLY marker', () => {
    const s = scan(DIST);
    expect(s.files).toBeGreaterThan(50); // the walker really walked a build, not an empty dir
    expect(s.pathHits).toEqual([]);
    expect(s.markerHits).toEqual([]);
  });

  it('npm pack --dry-run in dist/ lists no parity path', () => {
    const files = packList(DIST, fakeHome);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /parity/i.test(f))).toEqual([]);
  });

  it('structural guarantee: parity/ is in no publish config and the published AGENTS.md / docs carry no instrument text', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.filter((f) => /parity/i.test(f))).toEqual([]);
    const tsLib = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'tsconfig.lib.json'), 'utf8')) as { include: string[] };
    expect(tsLib.include.filter((f) => /parity/i.test(f))).toEqual([]);
    expect(fs.readFileSync(path.join(PACKAGE_ROOT, 'project.json'), 'utf8')).not.toMatch(/parity/i);
    // the README sits in parity/, not at the package root, so the build's `cp *.md` skips it
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'parity', 'README.md'))).toBe(true);
    for (const f of ['AGENTS.md', 'README.md', 'llms.txt']) {
      expect(fs.readFileSync(path.join(PACKAGE_ROOT, f), 'utf8')).not.toMatch(/PARITY-INSTRUMENT|entrypoint\/agent-mcp\/parity/);
    }
    const docs = path.join(PACKAGE_ROOT, 'docs');
    expect(scan(docs).markerHits).toEqual([]);
    expect(scan(docs).pathHits).toEqual([]);
  });

  it('NEGATIVE CONTROL: a dist copy with an injected parity/x.mjs turns the walker AND the pack listing red', () => {
    const copy = path.join(TMP, 'dist-copy');
    fs.cpSync(DIST, copy, { recursive: true });
    fs.mkdirSync(path.join(copy, 'parity'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'parity', 'x.mjs'), `// ${MARKER}\nexport {};\n`);
    const s = scan(copy);
    expect(s.pathHits).toContain(path.join('parity'));
    expect(s.pathHits).toContain(path.join('parity', 'x.mjs'));
    expect(s.markerHits).toEqual([path.join('parity', 'x.mjs')]);
    expect(packList(copy, fakeHome).filter((f) => /parity/i.test(f))).toContain('parity/x.mjs');
    // and the real dist is still green (the control did not touch it)
    expect(scan(DIST).pathHits).toEqual([]);
  });
});
