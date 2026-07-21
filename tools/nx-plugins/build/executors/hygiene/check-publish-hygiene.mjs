#!/usr/bin/env node
/**
 * scripts/check-publish-hygiene.mjs
 *
 * Publish-hygiene gate for BUG-AGENTMCP-003 (P0): several `@adhd/agent-*`
 * packages used to publish to npm with no/loose `files` allowlist, shipping
 * tests/docs/build-config alongside — or worse, silently omitting their own
 * `main`/`exports` target so the published package couldn't even be required.
 *
 * For each package this:
 *   1. Confirms the package has actually been built (its packageRoot dist dir
 *      + package.json exist) — a missing build is a hard failure, never a
 *      silent skip (a missing prerequisite must never read as a pass).
 *   2. Runs `npm pack --dry-run --json` FROM the built packageRoot (the exact
 *      directory `nx release publish` packs from — packageRoot: dist/{projectRoot}),
 *      so this exercises the real npm packing rules (`files` allowlist,
 *      always-included package.json/README/LICENSE/main), not an approximation.
 *   3. Asserts the resulting tarball file list:
 *        a. contains ZERO test/dev-config entries (__tests__/, *.test.*,
 *           *.spec.*, *.e2e.*, vite.config.*, project.json, tsconfig*.json,
 *           coverage/).
 *        b. DOES contain every `main` / `module` / `exports.*` target the
 *           package's own package.json declares — a missing target means the
 *           published package would be unrequireable/unimportable, which is
 *           strictly worse than shipping bloat.
 *
 * Usage:
 *   node scripts/check-publish-hygiene.mjs                # check the default package set
 *   node scripts/check-publish-hygiene.mjs --json          # machine-readable report on stdout
 *
 * Exit code is the SOLE source of truth: 0 = every package clean, 1 = at
 * least one violation (or a missing build/prerequisite). Never gate on the
 * human-readable text output.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Locate the workspace root by walking up to nx.json — robust to where this
// script lives (it moved from scripts/ into tools/nx-plugins/build/executors/).
const findRoot = (d) => { while (d !== path.dirname(d)) { if (existsSync(path.join(d, 'nx.json'))) return d; d = path.dirname(d); } return d; };
const REPO_ROOT = findRoot(__dirname);

// BUG-AGENTMCP-003: the 5 packages confirmed to ship with no/loose `files`
// allowlist. Extend this list as further packages are brought under the gate.
const DEFAULT_PACKAGES = [
  {
    name: '@adhd/agent-mcp',
    sourceDir: 'entrypoint/agent-mcp',
    distDir: 'dist/entrypoint/agent-mcp',
  },
  {
    name: '@adhd/agent-base-types',
    sourceDir: 'packages/agent/agent-base-types',
    distDir: 'dist/packages/agent/agent-base-types',
  },
  {
    name: '@adhd/agent-generator-plugin',
    sourceDir: 'packages/agent/agent-generator-plugin',
    distDir: 'dist/packages/agent/agent-generator-plugin',
    // This package's own shipped payload is an Nx generator: it legitimately
    // includes `src/generators/*/__files__/**` SCAFFOLD TEMPLATES for
    // packages it generates — filenames like `skeleton.test.ts__tmpl__` and
    // `vite.config.ts__tmpl__` are template DATA, not the package's own
    // test/dev-config bloat, and must not be flagged or excluded.
    exemptPathTest: (p) => /\/__files__\//.test(p),
  },
  {
    name: '@adhd/agent-plugin-budget',
    sourceDir: 'packages/agent/agent-plugin-budget',
    distDir: 'dist/packages/agent/agent-plugin-budget',
  },
  {
    name: '@adhd/agent-plugin-sanitize',
    sourceDir: 'packages/agent/agent-plugin-sanitize',
    distDir: 'dist/packages/agent/agent-plugin-sanitize',
  },
];

const FORBIDDEN_PATTERNS = [
  { label: '__tests__ directory', test: (p) => /(^|\/)__tests__\//.test(p) },
  { label: '*.test.*', test: (p) => /\.test\.[^/]+$/.test(p) },
  { label: '*.spec.*', test: (p) => /\.spec\.[^/]+$/.test(p) },
  { label: '*.e2e.*', test: (p) => /\.e2e\.[^/]+$/.test(p) },
  { label: 'vite.config.*', test: (p) => /(^|\/)vite\.config\.[^/]+$/.test(p) },
  { label: 'project.json', test: (p) => /(^|\/)project\.json$/.test(p) },
  { label: 'tsconfig*.json', test: (p) => /(^|\/)tsconfig[^/]*\.json$/.test(p) },
  { label: 'coverage/', test: (p) => /(^|\/)coverage\//.test(p) },
];

function stripLeadingDotSlash(p) {
  return p.replace(/^\.\//, '');
}

function collectExpectedTargets(pkgJson) {
  const targets = [];
  if (pkgJson.main) targets.push(['main', pkgJson.main]);
  if (pkgJson.module) targets.push(['module', pkgJson.module]);
  if (pkgJson.typings) targets.push(['typings', pkgJson.typings]);
  if (pkgJson.types) targets.push(['types', pkgJson.types]);
  if (pkgJson.exports) {
    const flatten = (obj, segments) => {
      for (const [key, value] of Object.entries(obj)) {
        // The exports map's subpath keys ("." for the default export, "./foo"
        // for a named subpath) are display-only path segments, not further
        // dotted properties — normalize "." to nothing rather than joining it.
        const segment = key === '.' ? [] : [key.replace(/^\.\//, '')];
        const nextSegments = [...segments, ...segment];
        if (typeof value === 'string') {
          targets.push([`exports${nextSegments.length ? '.' + nextSegments.join('.') : ''}`, value]);
        } else if (value && typeof value === 'object') {
          flatten(value, nextSegments);
        }
      }
    };
    flatten(pkgJson.exports, []);
  }
  // Only file-path-shaped targets (skip "generators" manifests etc — those
  // are checked separately by the packages that declare them, if ever).
  return targets.filter(([, target]) => typeof target === 'string' && target.startsWith('.'));
}

function checkPackage(pkg) {
  const result = {
    name: pkg.name,
    distDir: pkg.distDir,
    ok: false,
    errors: [],
    totalFiles: 0,
    forbiddenHits: [],
    checkedTargets: [],
  };

  const absDistDir = path.join(REPO_ROOT, pkg.distDir);
  const pkgJsonPath = path.join(absDistDir, 'package.json');

  if (!existsSync(absDistDir)) {
    result.errors.push(
      `dist dir missing: ${pkg.distDir} — package has not been built. ` +
        `Run \`npx nx build\` for this project before checking publish hygiene ` +
        `(a missing build must fail this gate, never pass silently).`
    );
    return result;
  }
  if (!existsSync(pkgJsonPath)) {
    result.errors.push(`${pkg.distDir}/package.json missing — broken/incomplete build output.`);
    return result;
  }

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

  const packResult = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: absDistDir,
    encoding: 'utf8',
  });

  if (packResult.status !== 0) {
    result.errors.push(
      `npm pack --dry-run exited ${packResult.status} in ${pkg.distDir}: ` +
        `${packResult.stderr?.trim() || packResult.stdout?.trim() || '(no output)'}`
    );
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(packResult.stdout);
  } catch (err) {
    result.errors.push(`could not parse npm pack --json output: ${err.message}`);
    return result;
  }

  const allFiles = (parsed[0]?.files ?? []).map((f) => f.path);
  result.totalFiles = allFiles.length;

  // Some packages (e.g. Nx generator plugins) legitimately ship scaffold
  // TEMPLATES whose filenames contain test/dev-config-shaped substrings
  // (`skeleton.test.ts__tmpl__`, `vite.config.ts__tmpl__`) — those are
  // template data, not the package's own bloat, and must be exempted from
  // the forbidden-pattern scan (never from the file-count/target checks).
  const files = pkg.exemptPathTest ? allFiles.filter((p) => !pkg.exemptPathTest(p)) : allFiles;

  // (a) zero forbidden test/dev-config entries
  for (const { label, test } of FORBIDDEN_PATTERNS) {
    const hits = files.filter(test);
    if (hits.length > 0) {
      result.forbiddenHits.push({ label, hits });
    }
  }

  // (b) every declared main/module/typings/exports target is present
  const expected = collectExpectedTargets(pkgJson);
  for (const [label, target] of expected) {
    const normalized = stripLeadingDotSlash(target);
    const present = allFiles.includes(normalized);
    result.checkedTargets.push({ label, target, present });
    if (!present) {
      result.errors.push(
        `declared "${label}": "${target}" is NOT in the packed tarball — ` +
          `published package would be broken/unimportable.`
      );
    }
  }

  if (result.forbiddenHits.length > 0) {
    for (const { label, hits } of result.forbiddenHits) {
      result.errors.push(`forbidden pattern "${label}" matched ${hits.length} file(s): ${hits.join(', ')}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

function main() {
  const asJson = process.argv.includes('--json');
  const results = DEFAULT_PACKAGES.map(checkPackage);
  const anyFailed = results.some((r) => !r.ok);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: !anyFailed, results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      const status = r.ok ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${r.name} (${r.distDir}) — ${r.totalFiles} file(s) in tarball`);
      if (r.checkedTargets.length > 0) {
        for (const t of r.checkedTargets) {
          console.log(`    ${t.present ? '✓' : '✗'} ${t.label}: ${t.target}`);
        }
      }
      for (const err of r.errors) {
        console.log(`    ERROR: ${err}`);
      }
    }
    console.log('');
    console.log(anyFailed ? 'publish-hygiene check: FAILED' : 'publish-hygiene check: all packages clean');
  }

  process.exit(anyFailed ? 1 : 0);
}

main();
