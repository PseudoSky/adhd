import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { createSingleFileBackend, CURRENT_FORMAT_VERSION } from '@adhd/apigen-plugin-ir-cache';

/** File name of the baked operations artifact, written beside the bundle in `dist/`. */
export const POLICY_IR_ARTIFACT_FILENAME = 'api.ir.json';

/** Bump when the artifact layout changes; a mismatch falls back to live extraction. */
export const POLICY_IR_FORMAT_VERSION = CURRENT_FORMAT_VERSION;

// This package is CommonJS-only (vite `formats: ['cjs']`), so `__filename` / `__dirname` are always defined.
const requirePkg = createRequire(__filename);

/**
 * The extractor version an artifact must have been produced by
 * (`@adhd/apigen-core-client`). Resolved lazily and tolerantly: a package whose
 * `exports` map hides `package.json` (`ERR_PACKAGE_PATH_NOT_EXPORTED`) must not
 * make the bin throw on load; the version then reads `unknown`, which never
 * matches a baked artifact, so start-up degrades to live extraction.
 */
export function expectedExtractorVersion(): string {
  try {
    const version = (requirePkg('@adhd/apigen-core-client/package.json') as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Where the baked artifact and `package.json` live. The bundle is `dist/*.js`
 * in the repo and the package root itself once published (`files` ships the
 * built directory as the root), and the source modules run from
 * `src/wrapper` under test, so the candidates are tried in order and the first
 * that holds `api.ir.json` or `cli.js` wins: the bundle's own directory, a
 * `dist/` beside it, a `dist/` one level up, and the package's `dist/` from
 * the source layout. With none present the bundle's own directory is returned.
 * `here` is the directory the lookup starts from (default: this module's own
 * directory); a caller passes another one to resolve a different layout.
 */
export function policyDistDir(here: string = __dirname): string {
  const candidates = [here, join(here, 'dist'), join(here, '..', 'dist'), join(here, '..', '..', 'dist')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, POLICY_IR_ARTIFACT_FILENAME)) || existsSync(join(candidate, 'cli.js'))) return candidate;
  }
  return here;
}

/** Absolute path of the baked artifact inside `distDir`. */
export function bakedIrArtifactPath(distDir: string): string {
  return join(distDir, POLICY_IR_ARTIFACT_FILENAME);
}

export interface IClientApi {
  /** The `service/api.d.ts` the operations are extracted from. */
  readonly apiDts: string;
  /** The declaration root whose `.d.ts` files make up the extracted surface. */
  readonly surfaceRoot: string;
}

/**
 * Locates the client's `service/api.d.ts` through the package name: the
 * rebased layout of an installed package (`<pkg>/service/api.d.ts`), else the
 * in-repo build output (`<pkg>/dist/service/api.d.ts`). `undefined` when the
 * client is not resolvable or not built.
 */
export function locateClientApi(): IClientApi | undefined {
  let packageJson: string;
  try {
    packageJson = requirePkg.resolve('@adhd/policy-core-client/package.json');
  } catch {
    return undefined;
  }
  const packageRoot = dirname(packageJson);
  for (const surfaceRoot of [packageRoot, join(packageRoot, 'dist')]) {
    const apiDts = join(surfaceRoot, 'service', 'api.d.ts');
    if (existsSync(apiDts)) return { apiDts, surfaceRoot };
  }
  return undefined;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * sha256 of every `.d.ts` under `root`, keyed by `root`-relative POSIX path,
 * skipping `node_modules`. The extracted operations are a function of the whole
 * declaration surface (extraction resolves types through `api.d.ts`'s sibling
 * imports), so this is the `artifactSource.deps` map the bake records and the
 * reader recomputes. Plain fs + crypto: the baked-artifact start-up path must not
 * load the extractor. Never throws; an unreadable directory contributes nothing,
 * which fails the equality check (a miss, never a stale hit).
 */
export function surfaceDepHashes(root: string): Record<string, string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, String(entry.name));
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(abs);
      } else if (entry.isFile() && String(entry.name).endsWith('.d.ts')) {
        files.push(abs);
      }
    }
  };
  walk(root);
  files.sort();
  const deps: Record<string, string> = {};
  for (const abs of files) deps[relative(root, abs).split(sep).join('/')] = sha256Hex(readFileSync(abs));
  return deps;
}

function sameDeps(recorded: Record<string, string>, actual: Record<string, string>): boolean {
  const keys = Object.keys(recorded).sort();
  const actualKeys = Object.keys(actual).sort();
  return keys.length === actualKeys.length && keys.every((key, index) => key === actualKeys[index] && recorded[key] === actual[key]);
}

/** Outcome of {@link inspectBakedIr}: the operations, or why the artifact cannot be used (`missing` = none was shipped). */
export type BakedIrInspection =
  | {
      readonly operations: Operation[];
      /** Set when the client declarations could not be located, so the artifact's `.d.ts` hashes were not compared. */
      readonly stalenessUnchecked?: true;
    }
  | { readonly reason: string };

/**
 * Reads the baked artifact: the `CachedExtractEntry` the ir-cache artifact target
 * stores, read through `createSingleFileBackend(file).get('')`. Reports `{reason}`
 * on missing, corrupt, format or extractor-version mismatch, or - when the client
 * declarations are resolvable - a `.d.ts` surface that no longer matches the
 * entry's `artifactSource.deps`, so any doubt degrades to live extraction rather
 * than serving a stale surface. Never throws.
 */
export async function inspectBakedIr(distDir: string): Promise<BakedIrInspection> {
  try {
    const file = bakedIrArtifactPath(distDir);
    if (!existsSync(file)) return { reason: 'missing' };
    const entry = await createSingleFileBackend(file).get('');
    if (entry === undefined) return { reason: 'artifact is unreadable (not a JSON entry)' };
    if (entry.formatVersion !== CURRENT_FORMAT_VERSION) return { reason: `artifact format ${String(entry.formatVersion)} is not ${CURRENT_FORMAT_VERSION}` };
    const extractorVersion = expectedExtractorVersion();
    if (extractorVersion === 'unknown' || entry.extractorVersion !== extractorVersion) {
      return { reason: `artifact was baked by extractor ${String(entry.extractorVersion)}, this install has ${extractorVersion}` };
    }
    if (!Array.isArray(entry.operations) || entry.operations.length === 0) return { reason: 'artifact holds no operations' };
    const client = locateClientApi();
    if (client === undefined) return { operations: entry.operations, stalenessUnchecked: true };
    const recorded = entry.artifactSource?.deps;
    if (recorded === undefined || !sameDeps(recorded, surfaceDepHashes(client.surfaceRoot))) {
      return { reason: 'the @adhd/policy-core-client declarations changed since the artifact was baked' };
    }
    return { operations: entry.operations };
  } catch (error) {
    return { reason: `artifact is unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The usable baked operations, or `undefined` (see {@link inspectBakedIr}). */
export async function readBakedIr(distDir: string): Promise<Operation[] | undefined> {
  const inspected = await inspectBakedIr(distDir);
  return 'operations' in inspected ? inspected.operations : undefined;
}

/**
 * The operations of the client's `service/api.ts`. Prefers the artifact baked
 * at build time; falls back to a live extraction of the client's declarations
 * (the only path that loads the extractor). A shipped artifact that cannot be
 * used (stale or mismatched) writes ONE stderr line through `onWarn` before the
 * fallback, so the slower start-up is explained rather than silent.
 * `distDir` is where the artifact is looked for (default: {@link policyDistDir}).
 */
export async function extractPolicyOperations(
  onWarn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
  distDir: string = policyDistDir()
): Promise<Operation[]> {
  const inspected = await inspectBakedIr(distDir);
  if ('operations' in inspected) {
    if (inspected.stalenessUnchecked === true) {
      onWarn('@adhd/policy: using the baked operation surface without checking it for staleness (the @adhd/policy-core-client declarations were not found)');
    }
    return inspected.operations;
  }
  if (inspected.reason !== 'missing') {
    onWarn(`@adhd/policy: ignoring the baked operation surface (${inspected.reason}); extracting live`);
  }
  const client = locateClientApi();
  if (client === undefined) {
    throw new Error(
      '@adhd/policy: cannot derive the command surface - @adhd/policy-core-client declarations were not found. ' +
        'Run "nx build policy-core-client" first.'
    );
  }
  return (await import('./ir-live')).extractPolicyOperationsLive(client.apiDts);
}

/**
 * Writes the baked artifact (atomically) to `outFile`; invoked by the
 * `ir-artifact` build step. The artifact is produced by the one core-client
 * IR-generation entry and shaped by the ir-cache artifact target (see
 * `./ir-live`), loaded lazily so this module stays extractor-free.
 */
export async function writeBakedIr(outFile: string): Promise<void> {
  const client = locateClientApi();
  if (client === undefined) {
    throw new Error('@adhd/policy: ir-artifact needs the built @adhd/policy-core-client declarations (service/api.d.ts).');
  }
  const extractorVersion = expectedExtractorVersion();
  if (extractorVersion === 'unknown') {
    throw new Error('@adhd/policy: ir-artifact cannot read the version of @adhd/apigen-core-client, so the artifact would be unverifiable.');
  }
  await (await import('./ir-live')).bakePolicyIr(outFile, client, extractorVersion);
}
