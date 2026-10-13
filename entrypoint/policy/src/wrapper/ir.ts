import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@adhd/apigen-core-client';

/** File name of the baked operations artifact, written beside the bundle in `dist/`. */
export const POLICY_IR_ARTIFACT_FILENAME = 'api.ir.json';

/** Bump when the artifact layout changes; a mismatch falls back to live extraction. */
export const POLICY_IR_FORMAT_VERSION = 1;

const requirePkg = createRequire(import.meta.url);

/** The extractor version an artifact must have been produced by (`@adhd/apigen-core-client`). */
export const EXPECTED_EXTRACTOR_VERSION: string = requirePkg('@adhd/apigen-core-client/package.json').version;

/** Where the baked artifact and `package.json` live: the bundle's own directory, or `dist/` when running from source. */
export function policyDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === 'dist' ? here : join(here, '..', '..', 'dist');
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

/**
 * Reads the baked artifact. Returns `undefined` on missing, corrupt, format or
 * extractor-version mismatch, or - when the client declarations are resolvable
 * - a surface digest that no longer matches, so any doubt degrades to live
 * extraction rather than serving a stale surface. Never throws.
 */
export function readBakedIr(distDir: string): Operation[] | undefined {
  try {
    const file = bakedIrArtifactPath(distDir);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<IBakedArtifact>;
    if (parsed.formatVersion !== POLICY_IR_FORMAT_VERSION) return undefined;
    if (parsed.extractorVersion !== EXPECTED_EXTRACTOR_VERSION) return undefined;
    if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return undefined;
    const client = locateClientApi();
    if (client !== undefined && parsed.surfaceSha256 !== surfaceDigest(client.surfaceRoot)) return undefined;
    return parsed.operations;
  } catch {
    return undefined;
  }
}

/**
 * The operations of the client's `service/api.ts`. Prefers the artifact baked
 * at build time; falls back to a live extraction of the client's declarations
 * (the only path that loads the extractor).
 */
export async function extractPolicyOperations(): Promise<Operation[]> {
  const baked = readBakedIr(policyDistDir());
  if (baked !== undefined) return baked;
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
  const operations = await (await import('./ir-live')).extractPolicyOperationsLive(client.apiDts);
  const artifact: IBakedArtifact = {
    formatVersion: POLICY_IR_FORMAT_VERSION,
    extractorVersion: EXPECTED_EXTRACTOR_VERSION,
    surfaceSha256: surfaceDigest(client.surfaceRoot),
    operations,
  };
  mkdirSync(dirname(outFile), { recursive: true });
  const temporary = `${outFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artifact)}\n`);
  renameSync(temporary, outFile);
}
