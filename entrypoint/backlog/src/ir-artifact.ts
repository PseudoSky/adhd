/**
 * ir-artifact.ts — the BAKE-AT-BUILD artifact seam (design doc Revision 3,
 * `docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md`).
 *
 * `nx build backlog` emits `dist/api.ir.json` — the extracted `Operation[]`
 * for `dist/api.d.ts` — inside the SAME build target that emits `api.d.ts`.
 * Server/CLI/MCP startup then reads that pre-built artifact behind a
 * content-hash freshness gate and never touches ts-morph at all; the runtime
 * IR cache stays only as a fallback for a missing/stale artifact.
 *
 * WHY this module is deliberately ts-morph-FREE: it is imported statically by
 * `server.ts` on the hot startup path (`--help`, every MCP `initialize`). The
 * whole point of the bake is that startup never loads the extractor; a single
 * transitive ts-morph import here would defeat it. The ONLY module allowed to
 * import extractor-touching code is `./extract-live.js`, and it is reached
 * exclusively through a dynamic `import()` on the fallback path.
 *
 * The freshness gate is intentionally a CONTENT hash of the CURRENT built
 * declarations — never the bake-time absolute paths recorded in the artifact: a
 * shipped artifact travels to machines where those paths do not exist, so the
 * reader re-hashes the files it is actually about to describe and refuses to
 * serve the artifact if any of them has drifted (never-serve-stale).
 *
 * It hashes the WHOLE `distDir` `*.d.ts` surface, not just `api.d.ts`. The
 * extracted operations are not a function of the entry file alone: extraction
 * resolves types THROUGH `api.d.ts`'s local sibling imports (e.g. every
 * `./write/*.js` `I*Input`/`I*Outcome` interface), so a drifted imported
 * declaration can change the operation set while `api.d.ts` stays
 * byte-identical. Hashing only `api.d.ts` would serve that drift as a HIT —
 * exactly the stale-surface the design's R3.3 guarantee forbids. This mirrors
 * what the runtime FALLBACK already does via `computeCacheKey`'s
 * `collectLocalImportPaths` dep hashes (`ir-cache-layer.ts`), computed here
 * with plain fs+crypto so this module stays ts-morph-free (an extractor import
 * here would defeat the whole bake).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  type Dirent,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteJson,
  CURRENT_FORMAT_VERSION,
  type CachedExtractEntry,
} from '@adhd/apigen-plugin-ir-cache';
import type { Operation } from '@adhd/apigen-core-client';

/** The artifact filename emitted into `dist/` by the `ir-artifact` subcommand. */
export const BACKLOG_IR_ARTIFACT_FILENAME = 'api.ir.json';

const requirePkg = createRequire(import.meta.url);

/**
 * The extractor version this build expects — the installed
 * `@adhd/apigen-core-client` package version. An artifact whose recorded
 * `extractorVersion` differs (e.g. a package baked against one core-client
 * release and consumed under another) is refused, because a changed extractor
 * can change extraction output for byte-identical input. This is the SAME
 * value `extract-live.ts` stamps into every runtime-cache entry
 * (`CORE_CLIENT_VERSION` there re-exports this constant), so the baked path,
 * the fallback cache, and the artifact gate can never disagree.
 *
 * Read here (not in `extract-live.ts`) precisely because this module must stay
 * ts-morph-free: a bare `package.json` version read is pure metadata.
 */
export const EXPECTED_EXTRACTOR_VERSION: string = requirePkg(
  '@adhd/apigen-core-client/package.json'
).version;

/**
 * Resolves the directory holding the built `api.d.ts`/`api.ir.json` for the
 * currently running module. Three layouts are supported without needing to
 * distinguish them explicitly (published npm package, this repo's own
 * `nx build backlog` output, and vitest running `src/` in place):
 *
 *  1. PUBLISHED (`node_modules/@adhd/backlog/dist/index.js`): `api.d.ts` is a
 *     sibling of the running module.
 *  2. DEV-BUILT (`entrypoint/backlog/dist/index.js`): identical sibling shape.
 *  3. VITEST (`entrypoint/backlog/src/...` transformed in place): `api.d.ts`
 *     is one level up and back down, under `../dist`.
 *
 * Probing "is api.d.ts sitting right next to me?" before falling back to the
 * vitest-only `../dist` shape covers all three. Moved here from `server.ts`
 * (verbatim, including this rationale) so the ts-morph-free artifact reader and
 * `server.ts` share ONE resolution — `extract-live.ts` imports it too, never a
 * second, drift-prone copy.
 */
export function backlogDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, 'api.d.ts'))) return here;
  return join(here, '..', 'dist');
}

/** Absolute path to the baked artifact inside `distDir`. */
export function bakedIrArtifactPath(distDir: string): string {
  return join(distDir, BACKLOG_IR_ARTIFACT_FILENAME);
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * sha256 of EVERY `*.d.ts` under `root`, keyed by `root`-relative POSIX path.
 *
 * This is the full set of declarations extraction can resolve a type through:
 * `api.d.ts` plus every local sibling/transitive `.d.ts` it imports (all live
 * under the same `distDir`). Walking the directory rather than re-deriving the
 * transitive import graph keeps `ir-artifact.ts` on plain fs+crypto — the
 * graph walk itself (`collectLocalImportPaths`) lives in
 * `@adhd/apigen-core-client` and would drag ts-morph onto the hot path the
 * bake removed. Hashing a deliberate superset is the conservative direction:
 * a drifted file that extraction never happened to read still refuses the
 * artifact, and the runtime fallback re-extracts it correctly.
 *
 * Absolute paths never enter the result (only `root`-relative keys), so the
 * same build hashes identically in the dev-built (`entrypoint/backlog/dist`)
 * and published (package-root) layouts.
 *
 * Pure fs+crypto: never throws on the READ path beyond the caller's own
 * try/catch (a missing root yields `{}` and therefore a mismatch → miss); on
 * the WRITE path a real I/O failure propagates so the build fails loudly
 * rather than emitting an unvalidatable artifact.
 */
function distSurfaceDepHashes(root: string): Record<string, string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory — contribute nothing. On the read path an empty
      // (or partial) set simply fails the equality check below → miss → the
      // live fallback; never a crash, never a stale HIT.
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, String(entry.name));
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && String(entry.name).endsWith('.d.ts')) {
        files.push(abs);
      }
    }
  };
  walk(root);
  files.sort();
  const deps: Record<string, string> = {};
  for (const abs of files) {
    deps[relative(root, abs).split(sep).join('/')] = sha256Hex(
      readFileSync(abs)
    );
  }
  return deps;
}

/**
 * Order-independent equality over two `distSurfaceDepHashes` maps: identical
 * relative path sets AND identical hashes. Any added/removed/edited `.d.ts`
 * fails it.
 */
function distSurfaceMatches(
  recorded: Record<string, string>,
  actual: Record<string, string>
): boolean {
  const recordedKeys = Object.keys(recorded).sort();
  const actualKeys = Object.keys(actual).sort();
  if (recordedKeys.length !== actualKeys.length) return false;
  for (let i = 0; i < recordedKeys.length; i++) {
    const key = recordedKeys[i] as string;
    if (key !== actualKeys[i]) return false;
    if (recorded[key] !== actual[key]) return false;
  }
  return true;
}

/**
 * Reads and VALIDATES the baked IR artifact for `distDir`.
 *
 * Returns `operations` ONLY when every gate passes; returns `undefined` (and
 * NEVER throws — a corrupt/partial artifact must degrade to the fallback, not
 * crash startup) on any of:
 *  - the artifact file is missing or unreadable;
 *  - it is not valid JSON, or does not carry an `operations` array;
 *  - `formatVersion` != the current entry format;
 *  - `extractorVersion` != {@link EXPECTED_EXTRACTOR_VERSION};
 *  - `artifactSource` is absent/malformed;
 *  - `api.d.ts` is missing, its byte length differs from the recorded one, or
 *    its sha256 does not match the recorded one (SOURCE-HASH-MISMATCH);
 *  - the `artifactSource.deps` full-`.d.ts`-surface map is absent/malformed, or
 *    the CURRENT `distDir` `*.d.ts` surface no longer matches it — an imported
 *    sibling declaration drifted even though `api.d.ts` did not
 *    (SURFACE-HASH-MISMATCH). Both are the never-serve-stale gate.
 *
 * @returns the baked operations, or `undefined` (never a throw) on any of the
 *   above — every one degrades to the live extraction fallback.
 */
export function readBakedIrArtifact(distDir: string): Operation[] | undefined {
  try {
    const artifactPath = bakedIrArtifactPath(distDir);
    if (!existsSync(artifactPath)) return undefined;

    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as Partial<
      CachedExtractEntry
    >;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (parsed.formatVersion !== CURRENT_FORMAT_VERSION) return undefined;
    if (parsed.extractorVersion !== EXPECTED_EXTRACTOR_VERSION) return undefined;

    const source = parsed.artifactSource;
    if (
      !source ||
      typeof source.sha256 !== 'string' ||
      typeof source.bytes !== 'number'
    ) {
      return undefined;
    }
    // An EMPTY operations array is not a valid artifact: `server.ts` serves a
    // truthy baked result verbatim (`if (baked) return baked`), so an empty
    // array would mount an empty surface instead of falling back. A real
    // backlog surface always has operations; reject rather than serve nothing.
    if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
      return undefined;
    }

    // Re-hash the CURRENT source — never the recorded (bake-machine-specific)
    // path — and compare. Any drift means the artifact no longer describes the
    // code about to be mounted: refuse it.
    const apiDts = join(distDir, 'api.d.ts');
    if (!existsSync(apiDts)) return undefined;
    const content = readFileSync(apiDts);
    if (content.byteLength !== source.bytes) return undefined;
    if (sha256Hex(content) !== source.sha256) return undefined;

    // SURFACE-HASH-MISMATCH: re-hash the WHOLE `*.d.ts` surface this distDir
    // exposes, not just `api.d.ts`. Extraction reads types THROUGH api.d.ts's
    // sibling imports, so a drifted imported `.d.ts` with a byte-identical
    // `api.d.ts` must refuse the artifact too (see this file's header). A
    // missing/malformed recorded map is unvalidatable → refuse.
    const recorded = source.deps;
    if (
      recorded === null ||
      typeof recorded !== 'object' ||
      Array.isArray(recorded)
    ) {
      return undefined;
    }
    for (const value of Object.values(recorded)) {
      if (typeof value !== 'string') return undefined;
    }
    if (!distSurfaceMatches(recorded, distSurfaceDepHashes(distDir))) {
      return undefined;
    }

    return parsed.operations;
  } catch {
    // Missing/corrupt/permission/parse — every one is a miss, never a throw.
    return undefined;
  }
}

/**
 * Writes the baked IR artifact to `outFile`, recording the provenance the
 * reader re-validates against: the source `.d.ts` path (audit), its sha256 and
 * byte length, plus a sha256 per EVERY `*.d.ts` under the artifact's `dist/`
 * (`artifactSource.deps`). Uses the plugin's shared `atomicWriteJson`, so the
 * artifact is published atomically and durably exactly like a runtime-cache
 * entry — a build killed mid-write can never leave a half-written artifact
 * behind.
 *
 * The per-file `deps` map is what makes the reader's freshness gate cover the
 * FULL extracted surface rather than only `api.d.ts`: extraction resolves
 * types through `api.d.ts`'s local siblings, so their content is part of what
 * the recorded `operations` depends on. See {@link readBakedIrArtifact}.
 *
 * `extractorVersion` is passed explicitly (the `ir-artifact` subcommand
 * supplies {@link EXPECTED_EXTRACTOR_VERSION}) rather than read here, so the
 * written artifact always records the version of the extractor that actually
 * produced `operations` — not merely the version installed at write time.
 */
export async function writeBakedIrArtifact(args: {
  apiDts: string;
  outFile: string;
  extractorVersion: string;
  operations: Operation[];
}): Promise<void> {
  const content = readFileSync(args.apiDts);
  const entry: CachedExtractEntry = {
    formatVersion: CURRENT_FORMAT_VERSION,
    operations: args.operations,
    extractorVersion: args.extractorVersion,
    createdAt: new Date().toISOString(),
    artifactSource: {
      path: args.apiDts,
      sha256: sha256Hex(content),
      bytes: content.byteLength,
      deps: distSurfaceDepHashes(dirname(args.apiDts)),
    },
  };
  await atomicWriteJson(args.outFile, entry);
}
