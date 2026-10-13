import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PolicyLoadError } from '../../core';
import type { ILayerInput, ILayerSource, LayerName } from '../../spec';
import { parsePolicyYaml } from './yaml';

/** File access port; the only way this module reads the disk. */
export interface IPolicyFs {
  /** Resolves `undefined` when the file does not exist; any other error throws. */
  readText(path: string): Promise<string | undefined>;
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
};

/** Source label of the built-in default layer. */
export const BUILTIN_DEFAULT_SOURCE = 'built-in';

/** The built-in default: no permissions, so every call is denied (`no-match`). Fail closed. */
export const BUILTIN_DEFAULT_DOCUMENT: { version: 1; permissions: [] } = { version: 1, permissions: [] };

/** Options for {@link createFsLayerSource}. */
export interface IFsLayerSourceOptions {
  /** Absolute; start of the walk-up. When omitted no walk-up happens (the cwd is never guessed). */
  readonly cwd?: string;
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

async function readLayer(fs: IPolicyFs, name: LayerName, path: string, required: boolean): Promise<ILayerInput | undefined> {
  let text: string | undefined;
  try {
    text = await fs.readText(path);
  } catch (error) {
    throw new PolicyLoadError('malformed', `${path}: cannot read policy file (${error instanceof Error ? error.message : String(error)})`);
  }
  if (text === undefined) {
    if (required) throw new PolicyLoadError('malformed', `${path}: policy file not found`);
    return undefined;
  }
  return { name, source: path, document: parsePolicyYaml(text, path) };
}

async function findProjectFile(fs: IPolicyFs, cwd: string): Promise<string | undefined> {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, PROJECT_FILE);
    let text: string | undefined;
    try {
      text = await fs.readText(candidate);
    } catch (error) {
      throw new PolicyLoadError('malformed', `${candidate}: cannot read policy file (${error instanceof Error ? error.message : String(error)})`);
    }
    if (text !== undefined) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * D-10: explicit files, else walk up from `cwd` for `workspace-policy.yaml`
 * (the project layer, stopping at the filesystem root) plus `globalFile` /
 * `localFile` when they exist; if none exist, the single built-in layer named
 * `global` with source `built-in`. Files are re-read on every `load()` (the memo
 * lives in the ctx). A file that exists but cannot be parsed throws
 * `PolicyLoadError` naming the file; the caller never receives a partial set.
 */
export function createFsLayerSource(options: IFsLayerSourceOptions): ILayerSource {
  const fs = options.fs ?? nodePolicyFs;
  return {
    async load(): Promise<readonly ILayerInput[]> {
      const layers: ILayerInput[] = [];
      if (options.explicit !== undefined && options.explicit.length > 0) {
        if (options.explicit.length > POSITIONAL.length) {
          throw new PolicyLoadError('malformed', `at most ${POSITIONAL.length} policy files may be given (global, project, local); got ${options.explicit.length}`);
        }
        for (let i = 0; i < options.explicit.length; i += 1) {
          const layer = await readLayer(fs, POSITIONAL[i], options.explicit[i], true);
          if (layer !== undefined) layers.push(layer);
        }
      } else {
        if (options.globalFile !== undefined) {
          const layer = await readLayer(fs, 'global', options.globalFile, false);
          if (layer !== undefined) layers.push(layer);
        }
        const projectPath = options.cwd === undefined ? undefined : await findProjectFile(fs, options.cwd);
        if (projectPath !== undefined) {
          const layer = await readLayer(fs, 'project', projectPath, true);
          if (layer !== undefined) layers.push(layer);
        }
        if (options.localFile !== undefined) {
          const layer = await readLayer(fs, 'local', options.localFile, false);
          if (layer !== undefined) layers.push(layer);
        }
      }
      if (layers.length === 0) {
        layers.push({ name: 'global', source: BUILTIN_DEFAULT_SOURCE, document: BUILTIN_DEFAULT_DOCUMENT });
      }
      options.onSource?.(`policy: ${layers.map((layer) => layer.source).join(', ')}`);
      return layers;
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
