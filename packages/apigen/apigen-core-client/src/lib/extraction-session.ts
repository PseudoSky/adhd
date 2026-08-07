// extraction-session.ts — per-run shared cache for the extraction pipeline.
//
// WHY THIS EXISTS (the redundant-program problem):
//
// Every `extract()` / `extractClasses()` call built its own ts-morph `Project`
// (parse lib.d.ts + the user's imports, ~1–2s each). Historically (before
// BUG-APIGEN-CORE-005 retired v1) the orchestrator ALSO called the now-deleted
// v1 `generateSchemas()` a second time per source — two full TypeScript
// programs per source, K sources deep — which is the double-pass this module
// was originally built to absorb into cache hits. That second call is gone
// (Step 5 of `buildDescriptor` now derives `ComposedSchemas` directly from
// `extract()`'s own `Operation[]` — one canonical extraction pass, not two),
// but the session remains load-bearing for the OTHER redundant-program
// sources it collapses: a multi-source run (`generate-registry`/
// `run-registry`, `serve`) shares one ts-morph Project per tsconfig across
// every package instead of one per package, and the ts-json-schema-generator
// side kept its own module-global cache that grew a new ~50–100MB entry on
// every file edit (mtime-keyed, never evicted), with every `buildSchema` call
// re-running `fs.statSync` + re-scanning the file's imports.
//
// An ExtractionSession scopes ALL of that to one run:
//   - one ts-morph Project per tsconfig (lib.d.ts parses once per run),
//   - one ts-json-schema-generator generator per (file, tsconfig),
//   - each (file, typeText) schema computed once and reused across every
//     operation in that source that references the same type,
//   - fs.stat and import-alias scans memoized per file,
// and `dispose()` drops every reference so a one-shot CLI run releases the
// whole graph. Long-running paths (serve/watch) create a session per rebuild,
// which is what makes cache invalidation trivially correct: a new run sees a
// fresh snapshot of the world.
//
// PUBLIC SURFACE IS OPAQUE ON PURPOSE: consumers only see `dispose()` and
// read-only `stats`. The ts-morph Project, generator cache, etc. are reached
// through `internalSession()` (not exported from the package index) so the
// public API carries zero coupling to ts-morph types.

import { Project, type SourceFile } from 'ts-morph';
import fs from 'node:fs';

/** Counters proving how much work a session actually did — used by perf regression tests. */
export interface ISessionStats {
  /** ts-morph Projects constructed (one per distinct tsconfig per session). */
  projectsBuilt: number;
  /** ts-json-schema-generator generators (full TS programs) constructed. */
  generatorsBuilt: number;
  /**
   * buildSchema calls answered from the session schema cache — includes both
   * a call that found an already-RESOLVED entry and a call that joined an
   * already-IN-FLIGHT promise for the same key (BUG-APIGEN-CORE-003:
   * in-flight dedup — see `schemaCache`'s doc comment below).
   */
  schemaCacheHits: number;
  /** buildSchema calls that had to start a new computation (cache miss). */
  schemaCacheMisses: number;
}

/**
 * A per-run cache shared across `extract()` / `extractClasses()` / the
 * orchestrator. Create one per logical run with
 * {@link createExtractionSession}, pass it to every extraction call in that
 * run, and `dispose()` it when the run's outputs have been consumed.
 *
 * Passing a session is optional everywhere — calls without one create a
 * private session internally and dispose it before returning, so existing
 * consumers are unaffected.
 */
export interface ExtractionSession {
  /** Drop every cached Project / generator / schema so the run's memory is collectible. */
  dispose(): void;
  /** Live work counters (see {@link ISessionStats}). */
  readonly stats: ISessionStats;
}

/** Cached built generator entry: `version` is the file's `mtimeMs:size` snapshot. */
export type BuiltGenerator = { createSchema(type: string): unknown };
type GeneratorEntry = { version: string; gen: BuiltGenerator };

const INTERNAL = Symbol.for('adhd.apigen.extraction-session');

/** Full internal surface — package-private (not exported from the index). */
export interface InternalExtractionSession extends ExtractionSession {
  [INTERNAL]: true;
  /** One ts-morph Project per distinct tsconfig path ('' for none). */
  projectFor(tsconfig?: string): Project;
  /** Add-or-reuse the SourceFile for `filePath` in the session's Project. */
  sourceFileFor(filePath: string, tsconfig?: string): SourceFile;
  /**
   * Memoized buildSchema results, key = `${sfPath}\0${tsconfig ?? ''}\0${typeText}`.
   *
   * BUG-APIGEN-CORE-003: values are the in-flight/resolved `Promise`, not the
   * resolved value itself, and are stored SYNCHRONOUSLY (before the underlying
   * computation is awaited) — this is what makes concurrent identical requests
   * (e.g. `morph-walk.ts`'s `Promise.all(members.map(...))` over union variants
   * that share a nested type like `SharedArrayBuffer`) share one computation
   * instead of each independently missing the cache and recomputing. See
   * `buildSchema()` in `schema-builders/ts-json-schema.ts` for the write side.
   */
  readonly schemaCache: Map<string, Promise<Record<string, unknown>>>;
  /** Memoized per-SourceFile import-alias maps (extractScalarAliases). */
  readonly aliasCache: WeakMap<SourceFile, ReadonlyMap<string, string>>;
  /** Memoized per-SourceFile zod-import check (sourceFileHasZodImport). */
  readonly zodImportCache: WeakMap<SourceFile, boolean>;
  /** One built generator per `${path}\0${tsconfig ?? ''}` — latest version only. */
  readonly generatorCache: Map<string, GeneratorEntry>;
  /** Memoized `mtimeMs:size` snapshot per file path (a run is a snapshot). */
  statVersion(pathStr: string): string;
}

/**
 * DEBT-APIGEN-CACHE-001: recursively walks `sf`'s local (non-`node_modules`)
 * `import`/`export ... from` targets, refreshing each visited file from disk
 * before descending into ITS imports (so edits to files 2+ hops away are
 * also detected), and accumulates every visited file path into `seen`.
 *
 * Pure AST-level module resolution (`getModuleSpecifierSourceFile()`) — this
 * does not require the type checker to have run, so it's cheap enough to run
 * once per `sourceFileFor()` call (once per extraction entry file per run),
 * not once per `buildSchema()` call.
 */
function collectReferencedFiles(sf: SourceFile, seen: Set<string>): void {
  const specifierSourceFiles = [
    ...sf.getImportDeclarations().map((d) => d.getModuleSpecifierSourceFile()),
    ...sf.getExportDeclarations().map((d) => d.getModuleSpecifierSourceFile()),
  ];
  for (const target of specifierSourceFiles) {
    if (!target) continue; // unresolved (bare package import, ambient module, …)
    const targetPath = target.getFilePath();
    if (targetPath.includes('/node_modules/')) continue;
    if (seen.has(targetPath)) continue;
    seen.add(targetPath);
    try {
      target.refreshFromFileSystemSync();
    } catch {
      // Deleted/unreadable — leave as last-known content; the outer
      // statVersion() call will still pick up a changed mtime/size if the
      // file is later restored, and a genuinely missing file simply stops
      // contributing to the composite version (matches fileVersion()'s own
      // 'nostat' sentinel behavior for a missing entry file).
    }
    collectReferencedFiles(target, seen);
  }
}

/** Compute a file's `mtimeMs:size` version string (uncached). */
export function fileVersion(pathStr: string): string {
  try {
    const st = fs.statSync(pathStr);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    // File may not exist yet (caller will surface the real error); use a sentinel.
    return 'nostat';
  }
}

/**
 * Persistent (process-lifetime) ts-morph Project tier, keyed by tsconfig path.
 *
 * Parsing lib.d.ts + building a TS program is the single largest cost of a
 * run (~1–2s). Sessions READ THROUGH to this tier so repeated runs in one
 * process (watch mode, serve rebuilds, test loops) reuse the parsed program
 * instead of rebuilding it. BOUNDED: one Project per distinct tsconfig, one
 * SourceFile per distinct file — a working set, not a leak; a file edited N
 * times is refreshed in place (mtime:size versioned), never duplicated.
 * A changed tsconfig (same path, new content) recreates its Project.
 */
interface IPersistentProject {
  project: Project;
  /** tsconfig file version the Project was built against ('' = no tsconfig). */
  tsconfigVersion: string;
  /** Last-seen version per loaded source file (refresh on mismatch). */
  fileVersions: Map<string, string>;
}
const _persistentProjects = new Map<string, IPersistentProject>();

/**
 * Persistent (process-lifetime) buildSchema result tier, keyed per
 * `(file, tsconfig)` with a composite version stamp that includes the
 * entry file AND all referenced files tracked by the persistent Project
 * tier. An edited file REPLACES its whole per-file map, so growth is
 * bounded to one map per distinct file, and entries are small JSON
 * fragments (not programs). A change to ANY imported file invalidates
 * the cache (DEBT-APIGEN-CACHE-001).
 */
interface IPersistentSchemas {
  version: string;
  schemas: Map<string, Record<string, unknown>>;
}
const _persistentSchemas = new Map<string, IPersistentSchemas>();

/** Persistent-schema accessor for buildSchema (package-private).
 *
 * Computes a composite version stamp that includes the entry file's version
 * AND the versions of all referenced files tracked by the persistent Project
 * tier.  Previously only the entry file's version was checked, so a type
 * imported from another file that changed without the entry file changing was
 * not detected (DEBT-APIGEN-CACHE-001).
 */
export function persistentSchemasFor(
  sfPath: string,
  tsconfig: string | undefined,
  version: string
): Map<string, Record<string, unknown>> {
  // Build a composite version: entry version + all referenced file versions
  // from the persistent project tier, sorted for determinism.
  const projKey = tsconfig ?? '';
  const projEntry = _persistentProjects.get(projKey);
  let compositeVersion = version;
  if (projEntry && projEntry.fileVersions.size > 0) {
    const parts: string[] = [version];
    const sorted = [...projEntry.fileVersions.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [path, ver] of sorted) {
      if (path !== sfPath) parts.push(`${path}:${ver}`);
    }
    compositeVersion = parts.join('|');
  }

  const key = `${sfPath}\0${tsconfig ?? ''}`;
  let entry = _persistentSchemas.get(key);
  if (!entry || entry.version !== compositeVersion) {
    entry = { version: compositeVersion, schemas: new Map() };
    _persistentSchemas.set(key, entry);
  }
  return entry.schemas;
}

/** Drop the process-lifetime Project + schema caches (tests / explicit memory reclaim). */
export function clearPersistentProjectCache(): void {
  _persistentProjects.clear();
  _persistentSchemas.clear();
}

/**
 * Create a fresh {@link ExtractionSession}.
 *
 * One session = one run = one snapshot of the source tree. Reusing a session
 * across file edits is unsupported by design (invalidation is "new session").
 */
export function createExtractionSession(): ExtractionSession {
  const stats: ISessionStats = {
    projectsBuilt: 0,
    generatorsBuilt: 0,
    schemaCacheHits: 0,
    schemaCacheMisses: 0,
  };
  const statCache = new Map<string, string>();
  let disposed = false;

  const session: InternalExtractionSession = {
    [INTERNAL]: true,
    stats,
    schemaCache: new Map(),
    aliasCache: new WeakMap(),
    zodImportCache: new WeakMap(),
    generatorCache: new Map(),

    projectFor(tsconfig?: string): Project {
      if (disposed)
        throw new Error('apigen-core: ExtractionSession used after dispose()');
      const key = tsconfig ?? '';
      const tsconfigVersion = tsconfig ? this.statVersion(tsconfig) : '';
      let entry = _persistentProjects.get(key);
      if (entry && entry.tsconfigVersion !== tsconfigVersion) {
        // tsconfig content changed — the old Program's compilerOptions are
        // stale. Replace the entry (the old Project becomes collectible).
        entry = undefined;
      }
      if (!entry) {
        const project = tsconfig
          ? new Project({
              tsConfigFilePath: tsconfig,
              skipAddingFilesFromTsConfig: true,
            })
          : new Project({ skipAddingFilesFromTsConfig: true });
        entry = { project, tsconfigVersion, fileVersions: new Map() };
        _persistentProjects.set(key, entry);
        stats.projectsBuilt++;
      }
      return entry.project;
    },

    sourceFileFor(filePath: string, tsconfig?: string): SourceFile {
      const project = this.projectFor(tsconfig);
      const entry = _persistentProjects.get(tsconfig ?? '');
      const version = this.statVersion(filePath);

      // Every source in a run shares one Project per tsconfig — and the
      // Project persists across runs, so the file may already be loaded
      // (addSourceFileAtPath throws on a duplicate).
      let sf = project.getSourceFile(filePath);
      if (sf === undefined) {
        sf = project.addSourceFileAtPath(filePath);
      } else if (entry && entry.fileVersions.get(filePath) !== version) {
        // File changed on disk since the persistent Project loaded it —
        // refresh in place (no duplicate SourceFile, no unbounded growth).
        sf.refreshFromFileSystemSync();
      }
      entry?.fileVersions.set(filePath, version);

      // DEBT-APIGEN-CACHE-001: also snapshot every LOCAL file this entry file
      // transitively imports (a type imported from another file, changed
      // without the entry file itself changing, was previously invisible to
      // `persistentSchemasFor`'s composite version stamp — it only tracked
      // whichever files happened to ALSO be extraction entry points in this
      // process). Refreshing each visited file from disk before reading its
      // own imports keeps the walk correct for changes N hops deep (e.g. the
      // entry imports B, B's on-disk content changed and now imports a new
      // C — refreshing B surfaces that new edge). node_modules is excluded:
      // we only chase the user's own source graph, not vendored .d.ts churn.
      if (entry) {
        const seen = new Set<string>([filePath]);
        collectReferencedFiles(sf, seen);
        for (const refPath of seen) {
          if (refPath === filePath) continue;
          entry.fileVersions.set(refPath, this.statVersion(refPath));
        }
      }

      return sf;
    },

    statVersion(pathStr: string): string {
      let v = statCache.get(pathStr);
      if (v === undefined) {
        v = fileVersion(pathStr);
        statCache.set(pathStr, v);
      }
      return v;
    },

    dispose(): void {
      // Releases the per-run caches. The persistent Project tier is
      // process-lifetime by design (bounded; see _persistentProjects) —
      // clearPersistentProjectCache() exists for explicit reclaim.
      disposed = true;
      this.schemaCache.clear();
      this.generatorCache.clear();
      statCache.clear();
    },
  };

  return session;
}

/**
 * Recover the internal surface from a public {@link ExtractionSession}.
 * Package-private — deliberately NOT exported from the package index.
 */
export function internalSession(
  session: ExtractionSession
): InternalExtractionSession {
  const s = session as InternalExtractionSession;
  if (s[INTERNAL] !== true) {
    throw new Error(
      'apigen-core: unknown ExtractionSession implementation — create sessions with createExtractionSession()'
    );
  }
  return s;
}
