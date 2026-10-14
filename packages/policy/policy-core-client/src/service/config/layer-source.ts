import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PolicyLoadError } from '../../core';
import { deepFreeze } from '../../core/canonical/clone';
import type { ILayerInput, ILayerSource, LayerName } from '../../spec';
import { markStableLayers } from '../stable-layers';
import { parsePolicyYaml } from './yaml';

/** What `IPolicyFs.stat` reports: enough to tell that a file changed without reading it. */
export interface IPolicyFileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

/** File access port; the only way this module reads the disk. */
export interface IPolicyFs {
  /** Resolves `undefined` when the file does not exist; any other error throws. */
  readText(path: string): Promise<string | undefined>;
  /**
   * Optional cheap probe. Resolves `undefined` when the file does not exist; any
   * other error throws. When present, an unchanged `(mtimeMs, size)` lets the
   * source skip reading and parsing the file, and the project-file walk-up tests
   * existence without reading each ancestor's file.
   */
  stat?(path: string): Promise<IPolicyFileStat | undefined>;
}

/** The real filesystem. */
export const nodePolicyFs: IPolicyFs = {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  },
  async stat(path: string): Promise<IPolicyFileStat | undefined> {
    try {
      const found = await stat(path);
      return { mtimeMs: found.mtimeMs, size: found.size };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  },
};

/** Source label of the built-in default layer. */
export const BUILTIN_DEFAULT_SOURCE = 'built-in';

/** The built-in default: no permissions, so every call is denied (`no-match`). Fail closed. */
export const BUILTIN_DEFAULT_DOCUMENT: { version: 1; permissions: [] } = { version: 1, permissions: [] };

/** Options for {@link createFsLayerSource}. */
export interface IFsLayerSourceOptions {
  /** Absolute; start of the walk-up. When omitted no walk-up happens (the cwd is never guessed). */
  readonly cwd?: string;
  /**
   * Absolute directory where the walk-up stops (inclusive): a file in an
   * ancestor above it is never adopted. Pass the user's home directory so a
   * stray policy file in `/` or `/home` cannot become a project layer. It has
   * no effect when `cwd` is not inside it. The walk-up always stops at the
   * filesystem root.
   */
  readonly stopAt?: string;
  /** Used as-is, in order, layer name by position (global, project, local); wins over discovery. */
  readonly explicit?: readonly string[];
  /** Optional global layer file (from env files); used when it exists. */
  readonly globalFile?: string;
  /** Optional local layer file (from env files); used when it exists. */
  readonly localFile?: string;
  readonly fs?: IPolicyFs;
  /** Called once per load with `policy: <paths|built-in>` text (D-12). */
  readonly onSource?: (label: string) => void;
}

const PROJECT_FILE = 'workspace-policy.yaml';
const POSITIONAL: readonly LayerName[] = ['global', 'project', 'local'];

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One parsed file, remembered under the signature it was read with. */
interface ICachedFile {
  sig: string | undefined;
  text: string;
  layer: ILayerInput;
}

async function probe(fs: IPolicyFs, path: string): Promise<IPolicyFileStat | undefined> {
  try {
    return await (fs.stat as NonNullable<IPolicyFs['stat']>)(path);
  } catch (error) {
    throw new PolicyLoadError('malformed', `${path}: cannot read policy file (${describe(error)})`);
  }
}

/**
 * Reads one layer file. With `fs.stat`, an unchanged `(mtimeMs, size)` returns the
 * remembered layer without touching the file; otherwise the file is read and,
 * when its text is byte-identical to the remembered text, the remembered parse is
 * reused. The signature is taken BEFORE the read, so a write racing the read can
 * only cause a later re-read, never a stale hit.
 */
async function readLayer(
  fs: IPolicyFs,
  cache: Map<string, ICachedFile>,
  name: LayerName,
  path: string,
  required: boolean
): Promise<ILayerInput | undefined> {
  const key = `${name}\0${path}`;
  let sig: string | undefined;
  if (fs.stat !== undefined) {
    const found = await probe(fs, path);
    if (found === undefined) {
      cache.delete(key);
      if (required) throw new PolicyLoadError('malformed', `${path}: policy file not found`);
      return undefined;
    }
    sig = `${found.mtimeMs}:${found.size}`;
    const hit = cache.get(key);
    if (hit?.sig === sig) return hit.layer;
  }
  let text: string | undefined;
  try {
    text = await fs.readText(path);
  } catch (error) {
    throw new PolicyLoadError('malformed', `${path}: cannot read policy file (${describe(error)})`);
  }
  if (text === undefined) {
    cache.delete(key);
    if (required) throw new PolicyLoadError('malformed', `${path}: policy file not found`);
    return undefined;
  }
  const hit = cache.get(key);
  if (hit?.text === text) {
    hit.sig = sig;
    return hit.layer;
  }
  const layer: ILayerInput = { name, source: path, document: deepFreeze(parsePolicyYaml(text, path)) };
  cache.set(key, { sig, text, layer });
  return layer;
}

async function exists(fs: IPolicyFs, path: string): Promise<boolean> {
  if (fs.stat !== undefined) return (await probe(fs, path)) !== undefined;
  try {
    return (await fs.readText(path)) !== undefined;
  } catch (error) {
    throw new PolicyLoadError('malformed', `${path}: cannot read policy file (${describe(error)})`);
  }
}

/** True when `dir` is `ancestor` or lies inside it (lexical, absolute paths). */
function isInside(dir: string, ancestor: string): boolean {
  return dir === ancestor || dir.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);
}

async function findProjectFile(fs: IPolicyFs, cwd: string, stopAt: string | undefined): Promise<string | undefined> {
  const start = resolve(cwd);
  const ceiling = stopAt === undefined ? undefined : resolve(stopAt);
  const bounded = ceiling !== undefined && isInside(start, ceiling);
  let dir = start;
  for (;;) {
    const candidate = join(dir, PROJECT_FILE);
    if (await exists(fs, candidate)) return candidate;
    if (bounded && dir === ceiling) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * D-10: explicit files, else walk up from `cwd` for `workspace-policy.yaml`
 * (the project layer, stopping at `stopAt` when `cwd` is inside it, and at the
 * filesystem root) plus `globalFile` / `localFile` when they exist; if none exist,
 * the single built-in layer named `global` with source `built-in`. Every
 * `load()` re-checks the files, so an edit is picked up; a file whose
 * `IPolicyFs.stat` signature (mtimeMs + size) is unchanged is not re-read or
 * re-parsed, and while no file changed `load()` returns the SAME array of the
 * SAME frozen layer objects, which lets the ctx skip hashing and compiling. A
 * file that exists but cannot be parsed throws `PolicyLoadError` naming the
 * file; the caller never receives a partial set. (A rewrite that keeps both the
 * mtime and the size is invisible to the signature; sources without `stat` fall
 * back to comparing the file text.)
 */
export function createFsLayerSource(options: IFsLayerSourceOptions): ILayerSource {
  const fs = options.fs ?? nodePolicyFs;
  const cache = new Map<string, ICachedFile>();
  const builtin: ILayerInput = deepFreeze({ name: 'global', source: BUILTIN_DEFAULT_SOURCE, document: BUILTIN_DEFAULT_DOCUMENT });
  let last: readonly ILayerInput[] | undefined;
  return {
    async load(): Promise<readonly ILayerInput[]> {
      const layers: ILayerInput[] = [];
      if (options.explicit !== undefined && options.explicit.length > 0) {
        if (options.explicit.length > POSITIONAL.length) {
          throw new PolicyLoadError('malformed', `at most ${POSITIONAL.length} policy files may be given (global, project, local); got ${options.explicit.length}`);
        }
        for (let i = 0; i < options.explicit.length; i += 1) {
          const layer = await readLayer(fs, cache, POSITIONAL[i], options.explicit[i], true);
          if (layer !== undefined) layers.push(layer);
        }
      } else {
        if (options.globalFile !== undefined) {
          const layer = await readLayer(fs, cache, 'global', options.globalFile, false);
          if (layer !== undefined) layers.push(layer);
        }
        const projectPath = options.cwd === undefined ? undefined : await findProjectFile(fs, options.cwd, options.stopAt);
        if (projectPath !== undefined) {
          const layer = await readLayer(fs, cache, 'project', projectPath, true);
          if (layer !== undefined) layers.push(layer);
        }
        if (options.localFile !== undefined) {
          const layer = await readLayer(fs, cache, 'local', options.localFile, false);
          if (layer !== undefined) layers.push(layer);
        }
      }
      if (layers.length === 0) {
        layers.push(builtin);
      }
      options.onSource?.(`policy: ${layers.map((layer) => layer.source).join(', ')}`);
      if (last?.length === layers.length && last.every((layer, i) => layer === layers[i])) return last;
      last = markStableLayers(Object.freeze(layers));
      return last;
    },
  };
}

/** A source over fixed in-memory layers. */
export function createMemoryLayerSource(layers: readonly ILayerInput[]): ILayerSource {
  return {
    async load(): Promise<readonly ILayerInput[]> {
      return layers;
    },
  };
}
