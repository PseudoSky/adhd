import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@adhd/apigen-core-client';

/** File name of the baked operations artifact, written beside the bundle in `dist/`. */
export const POLICY_IR_ARTIFACT_FILENAME = 'api.ir.json';

/** Bump when the artifact layout changes; a mismatch falls back to live extraction. */
export const POLICY_IR_FORMAT_VERSION = 1;

const requirePkg = createRequire(import.meta.url);

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
 */
export function policyDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
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

interface IClientApi {
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

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Digest over every `.d.ts` under `root` (relative path + content), skipping `node_modules`. */
function surfaceDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
  const lines = files.map((abs) => `${relative(root, abs).split(sep).join('/')}\0${sha256Hex(readFileSync(abs))}`);
  return sha256Hex(lines.join('\n'));
}

interface IBakedArtifact {
  readonly formatVersion: number;
  readonly extractorVersion: string;
  readonly surfaceSha256: string;
  readonly operations: Operation[];
}

/** Outcome of {@link inspectBakedIr}: the operations, or why the artifact cannot be used (`missing` = none was shipped). */
export type BakedIrInspection = { readonly operations: Operation[] } | { readonly reason: string };

/**
 * Reads the baked artifact. Reports `{reason}` on missing, corrupt, format or
 * extractor-version mismatch, or - when the client declarations are resolvable
 * - a surface digest that no longer matches, so any doubt degrades to live
 * extraction rather than serving a stale surface. Never throws.
 */
export function inspectBakedIr(distDir: string): BakedIrInspection {
  try {
    const file = bakedIrArtifactPath(distDir);
    if (!existsSync(file)) return { reason: 'missing' };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<IBakedArtifact>;
    if (parsed.formatVersion !== POLICY_IR_FORMAT_VERSION) return { reason: `artifact format ${String(parsed.formatVersion)} is not ${POLICY_IR_FORMAT_VERSION}` };
    const extractorVersion = expectedExtractorVersion();
    if (extractorVersion === 'unknown' || parsed.extractorVersion !== extractorVersion) {
      return { reason: `artifact was baked by extractor ${String(parsed.extractorVersion)}, this install has ${extractorVersion}` };
    }
    if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return { reason: 'artifact holds no operations' };
    const client = locateClientApi();
    if (client !== undefined && parsed.surfaceSha256 !== surfaceDigest(client.surfaceRoot)) {
      return { reason: 'the @adhd/policy-core-client declarations changed since the artifact was baked' };
    }
    return { operations: parsed.operations };
  } catch (error) {
    return { reason: `artifact is unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The usable baked operations, or `undefined` (see {@link inspectBakedIr}). */
export function readBakedIr(distDir: string): Operation[] | undefined {
  const inspected = inspectBakedIr(distDir);
  return 'operations' in inspected ? inspected.operations : undefined;
}

/**
 * The operations of the client's `service/api.ts`. Prefers the artifact baked
 * at build time; falls back to a live extraction of the client's declarations
 * (the only path that loads the extractor). A shipped artifact that cannot be
 * used (stale or mismatched) writes ONE stderr line through `onWarn` before the
 * fallback, so the slower start-up is explained rather than silent.
 */
export async function extractPolicyOperations(
  onWarn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)
): Promise<Operation[]> {
  const inspected = inspectBakedIr(policyDistDir());
  if ('operations' in inspected) return inspected.operations;
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

/** Writes `dist/api.ir.json` (atomically); invoked by the `ir-artifact` build step. */
export async function writeBakedIr(outFile: string): Promise<void> {
  const client = locateClientApi();
  if (client === undefined) {
    throw new Error('@adhd/policy: ir-artifact needs the built @adhd/policy-core-client declarations (service/api.d.ts).');
  }
  const extractorVersion = expectedExtractorVersion();
  if (extractorVersion === 'unknown') {
    throw new Error('@adhd/policy: ir-artifact cannot read the version of @adhd/apigen-core-client, so the artifact would be unverifiable.');
  }
  const operations = await (await import('./ir-live')).extractPolicyOperationsLive(client.apiDts);
  const artifact: IBakedArtifact = {
    formatVersion: POLICY_IR_FORMAT_VERSION,
    extractorVersion,
    surfaceSha256: surfaceDigest(client.surfaceRoot),
    operations,
  };
  mkdirSync(dirname(outFile), { recursive: true });
  const temporary = `${outFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artifact)}\n`);
  renameSync(temporary, outFile);
}
