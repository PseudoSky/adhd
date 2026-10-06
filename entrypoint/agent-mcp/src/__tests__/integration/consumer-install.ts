/**
 * consumer-install.ts — builds the artifact a CONSUMER gets and installs it the
 * way `npx -y @adhd/agent-mcp` / `npm i -g` would, for backlog 94125709.
 *
 * Release packs each package's BUILT `dist/` (PUBLISHING.md: "Publishing packs
 * the built dist/ directory itself"), so this does exactly that: walk the
 * `@adhd/*` dependency closure of agent-mcp through the workspace manifests,
 * `npm pack` every `dist/` into a tarball, then `npm i <tarballs>` into a fresh
 * directory OUTSIDE the repo. No workspace symlinks. Third-party deps (srt,
 * better-sqlite3, the MCP SDK, any @adhd package that is only on the registry)
 * resolve from the real npm registry, as they do for a consumer.
 *
 * Every prerequisite fails LOUDLY (a missing dist/package.json means the
 * `dist-manifest` targets did not run — wired through agent-mcp's `test`
 * dependsOn `^dist-manifest`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './portability-host.js';

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

const readJson = (p: string): Manifest => JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;

/** name -> workspace directory, for every package under packages/ and entrypoint/. */
function workspacePackageDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || ['node_modules', 'dist', '.nx'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      const pj = path.join(p, 'package.json');
      if (fs.existsSync(pj)) {
        try {
          dirs.set(readJson(pj).name, p);
        } catch {
          /* not a package manifest */
        }
      }
      walk(p, depth + 1);
    }
  };
  for (const top of ['packages', 'entrypoint']) walk(path.join(REPO_ROOT, top), 0);
  return dirs;
}

/** The workspace `@adhd/*` closure of `root` (packages with no workspace dir come from the registry). */
export function workspaceClosure(root = '@adhd/agent-mcp'): Array<{ name: string; dir: string }> {
  const dirs = workspacePackageDirs();
  const seen = new Set<string>();
  const out: Array<{ name: string; dir: string }> = [];
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = dirs.get(name);
    if (!dir) continue; // registry-only (e.g. @adhd/sox-store-adapter)
    out.push({ name, dir });
    for (const dep of Object.keys(readJson(path.join(dir, 'package.json')).dependencies ?? {})) {
      if (dep.startsWith('@adhd/')) queue.push(dep);
    }
  }
  return out;
}

/** `npm pack` every closure member's built dist/ into `tarDir`; returns the tarball paths. */
export function packClosure(tarDir: string): string[] {
  fs.mkdirSync(tarDir, { recursive: true });
  return workspaceClosure().map(({ name, dir }) => {
    const dist = path.join(dir, 'dist');
    if (!fs.existsSync(path.join(dist, 'package.json'))) {
      throw new Error(
        `${name}: ${dist}/package.json missing — run "npx nx run-many -t dist-manifest" ` +
          '(agent-mcp:test dependsOn ^dist-manifest)'
      );
    }
    const file = execFileSync('npm', ['pack', '--pack-destination', tarDir, '--silent'], {
      cwd: dist,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .pop() as string;
    return path.join(tarDir, file);
  });
}

/** Fresh consumer dir with every tarball installed via plain `npm i`. Returns the consumer root. */
export function installConsumer(consumerDir: string, tarballs: string[]): string {
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'consumer-94125709', version: '1.0.0', private: true })
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], {
    cwd: consumerDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return consumerDir;
}

/** The installed `agent-mcp` bin (the symlink `npx` execs), asserted to be a symlink into the package. */
export function installedBin(consumerDir: string): string {
  const bin = path.join(consumerDir, 'node_modules', '.bin', 'agent-mcp');
  if (!fs.existsSync(bin)) throw new Error(`installed bin missing: ${bin}`);
  return bin;
}
