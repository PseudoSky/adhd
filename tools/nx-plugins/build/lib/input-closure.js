'use strict';
/**
 * Runtime-closure cache inputs for `build` / `typecheck` (backlog 0b9505ff, c916591c).
 *
 * WHY: nx.json used `inputs: ["production", "^production"]` for build/typecheck. `^production`
 * expands over EVERY project-graph edge, and Nx edges carry no dependency kind — so a
 * devDependency that only a test imports (e.g. `agent-plugin-tracing` -> `agent-engine-orchestrator`
 * for its spec harness) widened the build/typecheck cache key with that dependency's whole
 * (transitive) source. Editing a dev-only dependency then invalidated a build whose output it
 * cannot change.
 *
 * WHAT: for each publishable project the build plugin computes the set of workspace projects
 * whose SOURCE can reach the built artifact, and emits it as a per-project `depsProduction`
 * named input made of explicit `{workspaceRoot}/<root>/...` globs (a named input cannot hold
 * `^production` or `{input, projects}` — Nx rejects both — so the dependency's `production`
 * fileset is re-expressed literally by `expandProduction`, derived from nx.json's own
 * `namedInputs` so it never drifts from the workspace definition).
 *
 * The closure is deliberately a SUPERSET of "what ships":
 *   - `dependencies` / `peerDependencies` / `optionalDependencies` that are workspace projects;
 *   - any other workspace project whose name (or relative path) is a quoted import specifier in
 *     the project's PRODUCTION-fileset source — a devDependency imported from non-test source is
 *     BUNDLED into dist (`externalizeRealDeps` keeps `@adhd/*` inline), so it must stay hashed;
 *   - positive `implicitDependencies` from project.json;
 *   - all of the above, transitively, applying the same rule to each dependency.
 * Test-only dependencies (imported only from spec/test files or fixture-like `test/` dirs, the same
 * files `tsconfig.lib.json` excludes from the build) are the only edges dropped. `test` keeps the
 * full `^production` closure (tests DO execute dev-dependency source).
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join, posix } = require('node:path');

/** Directory names never walked: not part of the built artifact's source graph. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'coverage', 'tmp', '.git', '.nx', '.storybook', 'cypress',
  'test', 'tests', '__tests__', '__mocks__', '__fixtures__', 'fixtures',
]);
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** Same families nx.json `production` excludes (spec/test/stories/cypress/test-setup/eslint config). */
const NON_PRODUCTION_FILE = /(?:\.(?:spec|test|stories|cy)\.[^/]*$)|(?:^|\/)(?:test-setup[^/]*|jest\.config\.[^/]*|cypress\.config\.[^/]*|eslint\.config\.[^/]*)$/;
/** Tooling-config files: a reference from these alone is not a source dependency. */
const CONFIG_FILE = /(?:^|\/)(?:vite|vitest)[^/]*\.config\.[^/]*$|(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/;

/** Quoted module specifier in an import position: `from 'x'`, `import 'x'`, `import('x')`, `require('x')`, `require.resolve('x')`. */
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)['"]([^'"\n]+)['"]/g;

/** Package name of a bare specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`). */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Blank out `//` and `/* *\/` comments (string-aware) so prose that merely MENTIONS a package
 * name in a doc comment is not mistaken for an import. A regex literal containing a quote can
 * desynchronise the scan until the next newline; the failure direction is over-inclusion.
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      i += 1;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * @typedef {{project: string, root: string, name: string}} IWorkspaceProject
 * @typedef {{byName: Map<string, IWorkspaceProject>, byRoot: Map<string, IWorkspaceProject>, rootsByLength: string[]}} IWorkspaceIndex
 */

/**
 * Index every workspace project that has a package.json next to a project.json.
 * @param {string} workspaceRoot
 * @param {string[]} configFiles workspace-relative package.json paths
 * @param {(root: string) => boolean} isSkipped
 * @returns {IWorkspaceIndex}
 */
function buildWorkspaceIndex(workspaceRoot, configFiles, isSkipped) {
  const byName = new Map();
  const byRoot = new Map();
  for (const pkgPath of configFiles) {
    const root = posix.dirname(pkgPath.split('\\').join('/'));
    if (isSkipped(root)) continue;
    const projectJson = join(workspaceRoot, root, 'project.json');
    if (!existsSync(projectJson)) continue;
    try {
      const name = JSON.parse(readFileSync(join(workspaceRoot, pkgPath), 'utf8')).name;
      const project = JSON.parse(readFileSync(projectJson, 'utf8')).name || (name ? name.replace(/^@[^/]+\//, '') : undefined);
      if (!project) continue;
      const entry = { project, root, name };
      byRoot.set(root, entry);
      if (name) byName.set(name, entry);
    } catch { /* unreadable manifest: not an indexable workspace project */ }
  }
  const rootsByLength = [...byRoot.keys()].sort((a, b) => b.length - a.length);
  return { byName, byRoot, rootsByLength };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Longest project root that contains the workspace-relative `path`, or null. */
function owningRoot(index, path) {
  for (const root of index.rootsByLength) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return null;
}

/**
 * Walk a project's production-fileset source (never descending into another project's root)
 * and report which OTHER workspace projects it references by quoted import specifier.
 * @param {string} workspaceRoot
 * @param {string} root project root
 * @param {IWorkspaceIndex} index
 * @returns {Map<string, {fromSource: boolean}>} referenced project root -> whether any non-config file references it
 */
function scanImportedProjects(workspaceRoot, root, index) {
  /** @type {Map<string, {fromSource: boolean}>} */
  const found = new Map();
  const note = (depRoot, fromSource) => {
    if (!depRoot || depRoot === root) return;
    const prev = found.get(depRoot);
    if (!prev) found.set(depRoot, { fromSource });
    else if (fromSource) prev.fromSource = true;
  };
  const visit = (relDir) => {
    let entries;
    try { entries = readdirSync(join(workspaceRoot, relDir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (index.byRoot.has(rel)) continue; // another project owns that subtree
        visit(rel);
      } else if (e.isFile() && CODE_FILE.test(e.name) && !NON_PRODUCTION_FILE.test(rel) && !e.name.endsWith('.d.ts')) {
        let text;
        try { text = stripComments(readFileSync(join(workspaceRoot, rel), 'utf8')); } catch { continue; }
        const fromSource = !CONFIG_FILE.test(rel);
        for (const m of text.matchAll(IMPORT_SPEC)) {
          const spec = m[1];
          if (spec.startsWith('./') || spec.startsWith('../')) {
            note(owningRoot(index, posix.normalize(posix.join(posix.dirname(rel), spec))), fromSource);
          } else {
            note(index.byName.get(packageNameOf(spec))?.root, fromSource);
          }
        }
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Workspace project roots named by the project's `implicitDependencies`, split into the positive
 * ones and the `!project` negations (which Nx applies over every other edge kind).
 * @returns {{positive: string[], negated: string[]}}
 */
function implicitDependencyRoots(workspaceRoot, root, index) {
  const projectJson = readJson(join(workspaceRoot, root, 'project.json')) || {};
  const byProject = new Map([...index.byRoot.values()].map((p) => [p.project, p.root]));
  const positive = [];
  const negated = [];
  for (const dep of projectJson.implicitDependencies || []) {
    if (typeof dep !== 'string') continue;
    const bare = dep.startsWith('!') ? dep.slice(1) : dep;
    const depRoot = byProject.get(bare) || index.byName.get(bare)?.root;
    if (depRoot) (dep.startsWith('!') ? negated : positive).push(depRoot);
  }
  return { positive, negated };
}

/** Workspace project roots a project declares as runtime dependencies. */
function runtimeDependencyRoots(workspaceRoot, root, index) {
  const pkg = readJson(join(workspaceRoot, root, 'package.json')) || {};
  const out = [];
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[section] || {})) {
      const dep = index.byName.get(name);
      if (dep && dep.root !== root) out.push(dep.root);
    }
  }
  return out;
}

/**
 * Create a memoizing resolver for per-project dependency roots.
 * @param {string} workspaceRoot
 * @param {IWorkspaceIndex} index
 */
function createClosureResolver(workspaceRoot, index) {
  const scans = new Map();
  const scan = (root) => {
    if (!scans.has(root)) scans.set(root, scanImportedProjects(workspaceRoot, root, index));
    return scans.get(root);
  };
  const direct = new Map();
  const directRoots = (root) => {
    if (!direct.has(root)) {
      const implicit = implicitDependencyRoots(workspaceRoot, root, index);
      const set = new Set([
        ...runtimeDependencyRoots(workspaceRoot, root, index),
        ...implicit.positive,
        ...scan(root).keys(),
      ]);
      set.delete(root);
      for (const negated of implicit.negated) set.delete(negated);
      direct.set(root, [...set].sort());
    }
    return direct.get(root);
  };
  const closures = new Map();
  return {
    /** Sorted transitive closure of {@link directRoots}, excluding `root`. */
    closureRoots(root) {
      if (!closures.has(root)) {
        const seen = new Set();
        const queue = [...directRoots(root)];
        while (queue.length) {
          const next = queue.pop();
          if (seen.has(next) || next === root) continue;
          seen.add(next);
          queue.push(...directRoots(next));
        }
        closures.set(root, [...seen].sort());
      }
      return closures.get(root);
    },
    /** Declared runtime workspace dependency roots (sorted, direct only). */
    runtimeRoots(root) { return [...new Set(runtimeDependencyRoots(workspaceRoot, root, index))].sort(); },
    /** True iff a NON-config production file of `root` references the project at `depRoot`. */
    importsFromSource(root, depRoot) { return scan(root).get(depRoot)?.fromSource === true; },
    /** True iff any production file of `root` (config included) references `depRoot`. */
    importsAnywhere(root, depRoot) { return scan(root).has(depRoot); },
  };
}

/** Replace the `{projectRoot}` token with a literal workspace-rooted path. */
function atRoot(value, root) {
  return value.split('{projectRoot}').join(`{workspaceRoot}/${root}`);
}

/**
 * Re-express one dependency project's `production` named input as literal globs, so it can be
 * hashed from a project that is NOT the dependency (a named input cannot hold `^production`).
 * Mirrors exactly what `^production` hashes for that dependency: its production fileset plus its
 * `manifest` JSON input. `sharedGlobals` is omitted: every project's own `production` already
 * carries the identical workspace-wide files.
 * @param {Record<string, any[]>} namedInputs nx.json `namedInputs`
 * @param {string} depRoot
 * @param {string[]} manifestExcludeFields the dependency's release-rewritten package.json fields
 * @param {string[]} nestedRoots roots of projects physically nested under depRoot
 * @returns {Array<string | object>}
 */
function expandProduction(namedInputs, depRoot, manifestExcludeFields, nestedRoots) {
  const out = [];
  const seen = new Set();
  const expand = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const entry of namedInputs[name] || []) {
      if (typeof entry === 'string') {
        const bare = entry.startsWith('!') ? entry.slice(1) : entry;
        if (!bare.includes('{') && namedInputs[bare] !== undefined) {
          if (bare === 'manifest') {
            out.push({ json: `{workspaceRoot}/${depRoot}/package.json`, excludeFields: manifestExcludeFields });
          } else if (bare !== 'sharedGlobals') {
            expand(bare);
          }
        } else if (bare.includes('{projectRoot}')) {
          out.push(atRoot(entry, depRoot));
        }
        // `{workspaceRoot}/...` entries are workspace-wide (already in the consumer's own inputs).
      }
    }
  };
  expand('production');
  for (const nested of nestedRoots) out.push(`!{workspaceRoot}/${nested}/**/*`);
  return out;
}

module.exports = {
  buildWorkspaceIndex,
  createClosureResolver,
  expandProduction,
  scanImportedProjects,
  stripComments,
};
