#!/usr/bin/env node
/**
 * Bundles agent-mcp into a single runnable file (dist/bundle/index.js).
 *
 * Why: a cold `npx @adhd/agent-mcp` downloads ~212 packages, which exceeds the
 * host's 30s MCP connect timeout. One bundled file (plus the native
 * better-sqlite3, the only external) collapses that install to one package.
 *
 * Migrations: every migrate-runner resolves its drizzle folder with
 * `new URL('../../drizzle', import.meta.url)`. Inside one bundle all of them
 * would resolve against the same file, so this script rewrites each runner's
 * URL to a per-package subfolder (`./drizzle/<label>`) and copies that package's
 * drizzle/ folder beside the bundle. Path resolution only; no SQL is changed.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const outDir = join(pkgRoot, 'dist', 'bundle');

const ENTRY = join(pkgRoot, 'dist', 'src', 'index.js');
const RUNNER = /migrate-runner\.(ts|js)$/;
const URL_EXPR = /new URL\((['"])\.\.\/\.\.\/drizzle\1, import\.meta\.url\)/g;

/**
 * Maps a migrate-runner path to its package label and source drizzle folder.
 * esbuild resolves workspace packages to their TypeScript sources (`src/`) as
 * well as `dist/`, so both layouts are accepted: the package root is the path
 * segment directly before `src` or `dist`.
 */
function runnerOwner(file) {
  const rel = relative(repoRoot, file).split(sep);
  const idx = rel.findIndex((seg, i) => i > 0 && (seg === 'src' || seg === 'dist'));
  if (idx < 1) return null;
  const pkgDir = join(repoRoot, ...rel.slice(0, idx));
  return { label: rel[idx - 1], drizzleDir: join(pkgDir, 'drizzle') };
}

const owners = new Map();

const perRunnerUrl = {
  name: 'per-package-migrations',
  setup(b) {
    b.onLoad({ filter: RUNNER }, (args) => {
      const owner = runnerOwner(args.path);
      if (!owner || !existsSync(owner.drizzleDir)) return undefined;
      owners.set(owner.label, owner.drizzleDir);
      const src = readFileSync(args.path, 'utf8');
      const contents = src.replace(URL_EXPR, `new URL('./drizzle/${owner.label}', import.meta.url)`);
      return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  },
};

/**
 * Some dependencies read their own version with a relative runtime require
 * (`require("../package.json")`). Inside the bundle that path resolves against
 * the bundle file, not the dependency, so the JSON is inlined at build time
 * from the module's own package.json. Applies only where the pattern occurs.
 */
const RELATIVE_PACKAGE_JSON = /[\w$]*require\w*\((['"])(\.{1,2}\/[^'"]*package\.json)\1\)/g;
const inlineRelativePackageJson = {
  name: 'inline-relative-package-json',
  setup(b) {
    b.onLoad({ filter: /\.(c|m)?[jt]s$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      if (!src.includes('package.json')) return undefined;
      let changed = false;
      const contents = src.replace(RELATIVE_PACKAGE_JSON, (match, quote, rel) => {
        const target = resolve(dirname(args.path), rel);
        if (!existsSync(target)) return match;
        changed = true;
        return `(${readFileSync(target, 'utf8').trim()})`;
      });
      if (!changed) return undefined;
      return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  },
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [ENTRY],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3'],
  // CJS-only dependencies (e.g. node-fetch) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);" },
  plugins: [perRunnerUrl, inlineRelativePackageJson],
  logLevel: 'warning',
});

for (const [label, drizzleDir] of owners) {
  cpSync(drizzleDir, join(outDir, 'drizzle', label), { recursive: true });
}

// The agent-mcp package's own drizzle folder is the entrypoint's migration set.
const selfDrizzle = join(pkgRoot, 'drizzle');
cpSync(selfDrizzle, join(outDir, 'drizzle', 'agent-mcp'), { recursive: true });

console.log(`bundle: ${join(outDir, 'index.js')} (${owners.size + 1} migration folders)`);

/**
 * Verifies the bundle the way an MCP host starts it: spawn the file, send
 * `initialize` on stdin, and require a JSON-RPC result on stdout within a
 * bounded deadline. The server does not exit on stdin close, so the child is
 * killed once the result arrives. Any failure exits non-zero.
 */
function verifyHandshake(bundleFile, deadlineMs = 60000) {
  return new Promise((resolveP, rejectP) => {
    const scratch = mkdtempSync(join(tmpdir(), 'agent-mcp-bundle-verify-'));
    const child = spawn(process.execPath, [bundleFile], {
      cwd: scratch,
      env: {
        ...process.env,
        ADHD_AGENT_DATABASE_PATH: join(scratch, 'agents.db'),
        ADHD_AGENT_REGISTRY_DB_PATH: join(scratch, 'registry.db'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`no initialize result within ${deadlineMs}ms; stderr: ${stderr.slice(0, 500)}`));
    }, deadlineMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('"result"')) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolveP(out.trim().split('\n')[0]);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (!out.includes('"result"')) {
        clearTimeout(timer);
        rejectP(new Error(`exited ${code} before initialize result; stderr: ${stderr.slice(0, 500)}`));
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bundle-verify', version: '0' } },
    }) + '\n');
  });
}

const response = await verifyHandshake(join(outDir, 'index.js'));
console.log(`verify: initialize OK -> ${response.slice(0, 120)}`);
