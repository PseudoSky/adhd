#!/usr/bin/env node
// select-staged-specs.mjs — DEBT-PROCESS-AFFECTED-TEST-001 Option 3 (fast path).
//
// Reads a NUL-free, newline-separated list of staged file paths (repo-root
// relative) on stdin and prints a JSON plan grouping them into per-nx-project
// vitest invocations, scoped to ONLY the spec files that are honestly
// implicated by what is staged:
//
//   1. A staged file that IS itself a spec (`*.spec.ts`/`*.test.ts`) — run it.
//   2. A staged non-spec file with a co-located same-basename spec in the
//      SAME directory (`foo.ts` -> `foo.spec.ts`) — run that spec.
//
// Deliberately NOT "every spec in the touched directory": measured against
// entrypoint/backlog/src/write/ (8 specs, real-concurrency proofs per
// AGENTS.md §7 "no mocking the DB"), that grouping took 71s for one commit —
// heavier than the co-located match this script performs, and still an
// honest superset the developer did not touch. Full-project/full-affected
// coverage remains the job of `.githooks/pre-push` and CI, not this gate.
//
// A project whose `test` target executor isn't `@nx/vite:test` (no reliable
// direct-vitest invocation available) is reported under `unsupported` so the
// caller can escalate those files to the nx-affected fallback rather than
// silently skipping them.
//
// Output shape:
// {
//   "projects": [
//     { "name": "backlog", "cwd": "entrypoint/backlog",
//       "configFile": "entrypoint/backlog/vite.config.ts",
//       "specs": ["entrypoint/backlog/src/query/card.spec.ts", ...] }
//   -- `configFile` and each `specs` entry are REPO-ROOT-relative (matching
//   -- project.json's own `configFile` convention), so the caller runs
//   -- vitest from the repo root, never `cd`s into `cwd` (which is reported
//   -- for diagnostics/grouping only).
//   ],
//   "unsupported": ["<staged file with no vite:test project found>", ...],
//   "unmatched": ["<staged file with no co-located spec — not run anywhere>", ...]
// }

import { readFileSync, existsSync, readSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readStdin() {
  const chunks = [];
  const fd = 0;
  const buf = Buffer.alloc(65536);
  // Synchronous stdin read — this runs inside a git hook, no event loop games.
  let bytes;
  while (true) {
    try {
      bytes = readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') break;
      throw e;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function findProjectRoot(fileAbsDir) {
  let dir = fileAbsDir;
  while (dir.startsWith(repoRoot)) {
    const candidate = path.join(dir, 'project.json');
    if (existsSync(candidate)) return dir;
    if (dir === repoRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}

function loadProjectMeta(projectRoot) {
  const pj = JSON.parse(
    readFileSync(path.join(projectRoot, 'project.json'), 'utf8')
  );
  const testTarget = pj.targets?.test;
  return {
    name: pj.name ?? path.basename(projectRoot),
    executor: testTarget?.executor ?? null,
    configFile: testTarget?.options?.configFile ?? null,
  };
}

export function computePlan(staged) {
  const projects = new Map(); // projectRoot -> { name, cwd, configFile, specs: Set }
  const unsupported = [];
  const unmatched = [];

  for (const rel of staged) {
    const abs = path.join(repoRoot, rel);
    const dir = path.dirname(abs);
    const projectRootAbs = findProjectRoot(dir);
    if (!projectRootAbs) {
      unmatched.push(rel);
      continue;
    }

    let meta;
    try {
      meta = loadProjectMeta(projectRootAbs);
    } catch {
      unmatched.push(rel);
      continue;
    }

    if (meta.executor !== '@nx/vite:test' || !meta.configFile) {
      unsupported.push(rel);
      continue;
    }

    const isSpec = /\.(spec|test)\.(ts|tsx|mts|cts)$/.test(rel);
    let specAbs = null;
    if (isSpec) {
      specAbs = abs;
    } else {
      const ext = path.extname(abs);
      const base = abs.slice(0, -ext.length);
      const candidate = `${base}.spec${ext}`;
      if (existsSync(candidate)) specAbs = candidate;
    }

    if (!specAbs) {
      unmatched.push(rel);
      continue;
    }

    if (!projects.has(projectRootAbs)) {
      projects.set(projectRootAbs, {
        name: meta.name,
        cwd: path.relative(repoRoot, projectRootAbs),
        configFile: meta.configFile,
        specs: new Set(),
      });
    }
    const entry = projects.get(projectRootAbs);
    // repo-root-relative: project.json's `configFile` is ALSO repo-root-relative
    // (verified against entrypoint/backlog/project.json), and vitest is invoked
    // from repoRoot (not the project dir) so both paths resolve consistently.
    entry.specs.add(path.relative(repoRoot, specAbs));
  }

  const out = {
    projects: [...projects.values()].map((p) => ({
      name: p.name,
      cwd: p.cwd,
      configFile: p.configFile,
      specs: [...p.specs].sort(),
    })),
    unsupported,
    unmatched,
  };
  return out;
}

function main() {
  const input = readStdin().trim();
  const staged = input.length ? input.split('\n').filter(Boolean) : [];
  process.stdout.write(JSON.stringify(computePlan(staged)));
}

// Only self-invoke when run directly (e.g. `node select-staged-specs.mjs`),
// not when imported by run-staged-tests.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
