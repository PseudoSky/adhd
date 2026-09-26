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
 * The freshness gate is intentionally a CONTENT hash of the CURRENT
 * `api.d.ts`, not the bake-time absolute path recorded in the artifact: a
 * shipped artifact travels to machines where the bake-time path does not
 * exist, so the reader re-hashes the file it is actually about to describe and
 * refuses to serve the artifact if that content has drifted (never-serve-stale).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
 *    its sha256 does not match the recorded one (SOURCE-HASH-MISMATCH — the
 *    never-serve-stale gate).
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
    if (!Array.isArray(parsed.operations)) return undefined;

    // Re-hash the CURRENT source — never the recorded (bake-machine-specific)
    // path — and compare. Any drift means the artifact no longer describes the
    // code about to be mounted: refuse it.
    const apiDts = join(distDir, 'api.d.ts');
    if (!existsSync(apiDts)) return undefined;
    const content = readFileSync(apiDts);
    if (content.byteLength !== source.bytes) return undefined;
    if (sha256Hex(content) !== source.sha256) return undefined;

    return parsed.operations;
  } catch {
    // Missing/corrupt/permission/parse — every one is a miss, never a throw.
    return undefined;
  }
}

/**
 * Writes the baked IR artifact to `outFile`, recording the provenance the
 * reader re-validates against: the source `.d.ts` path (audit), its sha256 and
 * byte length. Uses the plugin's shared `atomicWriteJson`, so the artifact is
 * published atomically and durably exactly like a runtime-cache entry — a
 * build killed mid-write can never leave a half-written artifact behind.
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
    },
  };
  await atomicWriteJson(args.outFile, entry);
}
