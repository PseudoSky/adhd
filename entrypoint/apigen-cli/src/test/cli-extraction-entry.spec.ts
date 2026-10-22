/**
 * guards: `--opt` / `--use` handling through the CLI commands regresses: a `--use` plugin's createLayer sees something other than the invocation's flat --opt bag, runs more than once per invocation, runs on a generate path, or is bypassed by a target; a `--source` classification error loses its `--source <x>:` form; or `--opt http.verb.<id>=GET` is parsed but never reaches the projection on generate or run
 * tier: S
 * cites: REMEDIATION-PLAN T-R5 (policy-core, R5) AC1 createLayer once per invocation from the flat --opt bag under run; AC2 generate does not materialise layers while extractLayer still gets the bag; AC3 loadUsePlugins `materialise` flag; AC4 resolver errors surface as `--source <x>: ...`; AC5 extractLayer.createLayer runs once for a multi-source invocation. T-R5a (R5a, backlog 0bc4f3f6) AC6 --opt http.verb.<id>=GET changes the projected verb on generate; AC7 same on run, and the unoverridden control stays POST
 * tags: regression:0bc4f3f6, contract
 * teeth: red: npx vitest run --config entrypoint/apigen-cli/vite.config.ts src/test/cli-extraction-entry.spec.ts -> exit 1 under production negative controls (each restored with git restore): AC1/AC3 (loadUsePlugins never materialises) `expected [] to deeply equal [ { k: 'v' } ]`; AC2 (generate drops the `false` flag) `expected [ { k: 'v' } ] to deeply equal []`; AC4 (run drops the `--source <x>:` prefix) `expected [Function] to throw error matching /^--source ...`; AC5 (invokerCache not passed to the entry) `expected [ { k: 'v' }, { k: 'v' } ] to deeply equal [ { k: 'v' } ]`; AC6 (orchestrateGenerate hands pluginOpts without the projection) and AC7 (orchestrateRun likewise) `expected 'POST' to be 'GET'`
 *
 * Consumer path: the real Commander `generate` and `run` commands (registerGenerateCommand / registerRunCommand), the real loadUsePlugins, real orchestrator, real core-client extraction entry and real ts-morph extraction over a tiny temp source, with a recording output plugin as the only fake. The `--use` fixture is a real ES module loaded by dynamic import, exactly as a third-party plugin is. No sleeps, no subprocess.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { project } from '@adhd/apigen-engine-naming';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import type { Operation, OutputPlugin, Plugin } from '@adhd/apigen-core-client';
import { registerGenerateCommand } from '../lib/commands/generate';
import { loadUsePlugins, registerRunCommand } from '../lib/commands/run';

const SCRATCH_ROOT = path.resolve(__dirname, '../../../../tmp/apigen-cli');

/** The slice of PluginInput / RunInput the recording plugin reads. */
interface IPluginInput {
  options: Record<string, unknown>;
  operations?: Operation[];
}

interface IRecorder {
  options?: Record<string, unknown>;
  operations?: Operation[];
  events: string[];
}

interface ILayerCounters {
  layerCreated: Array<Record<string, unknown>>;
  extractCreated: Array<Record<string, unknown>>;
}

const COUNTERS_KEY = '__apigenCliSpecCounters';
const counters = (): ILayerCounters =>
  (globalThis as Record<string, unknown>)[COUNTERS_KEY] as ILayerCounters;

let root: string;
let seq = 0;

/** A tiny TS source: `createItem` takes an object, so it projects to POST by default. */
function writeSource(dir: string, name = 'api.ts', body?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } })
  );
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    body ?? 'export function createItem(payload: { x: number }): string { return String(payload.x); }\n'
  );
  return file;
}

/** The `--use` fixture: a real ES module with a layer capability and an extractLayer capability, both counting. */
function writeLayerPlugin(dir: string): string {
  const file = path.join(dir, 'layer-plugin.mjs');
  fs.writeFileSync(
    file,
    `const c = () => globalThis['${COUNTERS_KEY}'];
export default {
  id: 'echo-layer',
  description: 'fixture',
  capabilities: {
    layer: {
      createLayer(opts) {
        c().layerCreated.push({ ...opts });
        const k = opts.k;
        const built = () => k;
        return built;
      },
    },
    extractLayer: {
      createLayer(opts) {
        c().extractCreated.push({ ...opts });
        return (call, next) => next(call);
      },
    },
  },
};
`
  );
  return file;
}

function recordingPlugin(id: string, rec: IRecorder): OutputPlugin {
  return {
    id,
    description: `${id} fixture`,
    generate: async (input: IPluginInput) => {
      rec.options = input.options;
      rec.operations = input.operations;
      rec.events.push('generate');
      return { files: [] };
    },
    run: async (input: IPluginInput) => {
      rec.options = input.options;
      rec.operations = input.operations;
      rec.events.push('run');
    },
  } as unknown as OutputPlugin;
}

async function invoke(args: string[], plugins: Record<string, OutputPlugin>): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerGenerateCommand(program, plugins);
  registerRunCommand(program, plugins);
  const before = signalListeners();
  try {
    await program.parseAsync(['node', 'apigen', ...args]);
  } finally {
    // `run` installs process-level signal handlers; remove exactly the ones this invocation added.
    for (const [sig, fn] of signalListeners()) {
      if (!before.some(([s, f]) => s === sig && f === fn)) {
        process.removeListener(sig, fn);
      }
    }
  }
}

function signalListeners(): Array<[NodeJS.Signals, (...args: unknown[]) => void]> {
  const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  return sigs.flatMap((s) =>
    process.listeners(s).map((fn) => [s, fn as (...args: unknown[]) => void] as [NodeJS.Signals, (...args: unknown[]) => void])
  );
}

beforeAll(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(SCRATCH_ROOT, `entry-${String(seq++)}-`));
  process.env['APIGEN_LOG_LEVEL'] = 'silent';
  (globalThis as Record<string, unknown>)[COUNTERS_KEY] = { layerCreated: [], extractCreated: [] } satisfies ILayerCounters;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[COUNTERS_KEY];
  delete process.env['APIGEN_LOG_LEVEL'];
  const resolved = path.resolve(root);
  if (!resolved.startsWith(SCRATCH_ROOT + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside ${SCRATCH_ROOT}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe('T-R5 AC1: `run --use <plugin> --opt k=v` builds the layer once from the flat --opt bag', () => {
  it('createLayer runs once with exactly {k:"v"} and the run plugin receives the materialised layer', async () => {
    const source = writeSource(path.join(root, 'src'));
    const pluginFile = writeLayerPlugin(root);
    const rec: IRecorder = { events: [] };
    await invoke(
      ['run', '--source', source, '--type', 'rec', '--use', pluginFile, '--opt', 'k=v'],
      { rec: recordingPlugin('rec', rec) }
    );

    expect(counters().layerCreated).toEqual([{ k: 'v' }]);
    const used = rec.options?.['usePlugins'] as Plugin[];
    expect(used).toHaveLength(1);
    const layerCap = used[0].capabilities?.layer as { layer?: () => unknown; createLayer?: unknown };
    expect(layerCap.createLayer).toBeUndefined();
    expect(layerCap.layer?.()).toBe('v');
    expect(rec.events).toEqual(['run']);
  });

  it('the bag is the user --opt pairs only: argv passthrough and usePlugins are not in what createLayer sees', async () => {
    const source = writeSource(path.join(root, 'src'));
    const pluginFile = writeLayerPlugin(root);
    const rec: IRecorder = { events: [] };
    await invoke(
      ['run', '--source', source, '--type', 'rec', '--use', pluginFile, '--opt', 'k=v', '--opt', 'other=1', '--', 'cmd', 'arg'],
      { rec: recordingPlugin('rec', rec) }
    );
    expect(counters().layerCreated).toEqual([{ k: 'v', other: '1' }]);
    expect(counters().extractCreated).toEqual([{ k: 'v', other: '1' }]);
    expect(rec.options?.['argv']).toEqual(['cmd', 'arg']);
  });
});

describe('T-R5 AC2: `generate` does not materialise layers but extractLayer still gets the bag', () => {
  it('layer.createLayer never runs; extractLayer.createLayer runs once with {k:"v"}; the plugin is handed unmaterialised', async () => {
    const source = writeSource(path.join(root, 'src'));
    const pluginFile = writeLayerPlugin(root);
    const rec: IRecorder = { events: [] };
    await invoke(
      ['generate', '--source', source, '--type', 'rec', '--out-dir', path.join(root, 'out'), '--use', pluginFile, '--opt', 'k=v'],
      { rec: recordingPlugin('rec', rec) }
    );
    expect(counters().layerCreated).toEqual([]);
    expect(counters().extractCreated).toEqual([{ k: 'v' }]);
    expect(rec.events).toEqual(['generate']);
  });
});

describe('T-R5 AC3: loadUsePlugins `materialise` flag', () => {
  it('materialise=false returns the plugin as loaded (createLayer still present, factory not run)', async () => {
    const pluginFile = writeLayerPlugin(root);
    const [plugin] = await loadUsePlugins([pluginFile], { k: 'v' }, false);
    const cap = plugin.capabilities?.layer as { createLayer?: unknown; layer?: unknown };
    expect(typeof cap.createLayer).toBe('function');
    expect(cap.layer).toBeUndefined();
    expect(counters().layerCreated).toEqual([]);
  });

  it('materialise defaults to true: built once, input plugin not mutated, copy carries the built layer', async () => {
    const pluginFile = writeLayerPlugin(root);
    const [unmaterialised] = await loadUsePlugins([pluginFile], { k: 'v' }, false);
    const [plugin] = await loadUsePlugins([pluginFile], { k: 'w' });
    expect(counters().layerCreated).toEqual([{ k: 'w' }]);
    const cap = plugin.capabilities?.layer as { createLayer?: unknown; layer?: () => unknown };
    expect(cap.createLayer).toBeUndefined();
    expect(cap.layer?.()).toBe('w');
    expect(typeof (unmaterialised.capabilities?.layer as { createLayer?: unknown }).createLayer).toBe('function');
  });

  it('a createLayer that returns a non-function fails naming the --use specifier', async () => {
    const file = path.join(root, 'bad-plugin.mjs');
    fs.writeFileSync(file, `export default { id: 'bad', capabilities: { layer: { createLayer() { return 42; } } } };\n`);
    await expect(loadUsePlugins([file], {})).rejects.toThrow(
      new RegExp(`--use ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: layer capability createLayer\\(\\) returned number, not a layer function`)
    );
  });
});

describe('T-R5 AC4: resolver errors surface as `--source <x>: ...`', () => {
  it('run with an unclassifiable --source names it in the `--source <x>:` form', async () => {
    const bogus = path.join(root, 'api.unknownext');
    fs.writeFileSync(bogus, '');
    const rec: IRecorder = { events: [] };
    await expect(
      invoke(['run', '--source', bogus, '--type', 'rec'], { rec: recordingPlugin('rec', rec) })
    ).rejects.toThrow(new RegExp(`^--source ${bogus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    expect(rec.events).toEqual([]);
  });
});

describe('T-R5 AC5: extractLayer.createLayer runs once for a multi-source invocation', () => {
  it('two sources through one buildDescriptor build the extract layer once', async () => {
    const { orchestrateGenerate } = await import('../lib/orchestrator');
    const a = writeSource(path.join(root, 'a'), 'api.ts');
    const b = writeSource(path.join(root, 'b'), 'api.ts');
    const pluginFile = writeLayerPlugin(root);
    const usePlugins = await loadUsePlugins([pluginFile], { k: 'v' }, false);
    const rec: IRecorder = { events: [] };
    await orchestrateGenerate(
      {
        sources: [
          { file: a, namespace: 'one' },
          { file: b, namespace: 'two' },
        ],
        usePluginObjects: usePlugins,
        extractLayerOptions: { k: 'v' },
      },
      recordingPlugin('rec', rec),
      path.join(root, 'out'),
      { k: 'v' }
    );
    expect(rec.operations?.map((o) => o.namespace.raw).sort()).toEqual(['one', 'two']);
    expect(counters().extractCreated).toEqual([{ k: 'v' }]);
  });
});

describe('T-R5a (backlog 0bc4f3f6): `--opt http.verb.<id>=GET` reaches the projection', () => {
  /** The verb the operation projects to under the projection config the plugin was handed. */
  function projectedVerb(rec: IRecorder): string {
    const op = rec.operations?.[0];
    if (!op) throw new Error('plugin received no operations');
    const projection = (rec.options?.['projection'] ?? {}) as ProjectionConfig;
    return project(op, projection).http.verb;
  }

  it('generate: the override flips POST to GET for exactly that operation; without it the verb stays POST', async () => {
    const source = writeSource(path.join(root, 'src'));
    const control: IRecorder = { events: [] };
    await invoke(
      ['generate', '--source', source, '--type', 'rec', '--out-dir', path.join(root, 'out0'), '--namespace', 'svc'],
      { rec: recordingPlugin('rec', control) }
    );
    expect(projectedVerb(control)).toBe('POST');
    const id = control.operations?.[0].id as string;

    const rec: IRecorder = { events: [] };
    await invoke(
      ['generate', '--source', source, '--type', 'rec', '--out-dir', path.join(root, 'out1'), '--namespace', 'svc', '--opt', `http.verb.${id}=GET`],
      { rec: recordingPlugin('rec', rec) }
    );
    expect(projectedVerb(rec)).toBe('GET');
  });

  it('run: the override flips POST to GET for that operation; without it the verb stays POST', async () => {
    const source = writeSource(path.join(root, 'src'));
    const control: IRecorder = { events: [] };
    await invoke(
      ['run', '--source', source, '--type', 'rec', '--namespace', 'svc'],
      { rec: recordingPlugin('rec', control) }
    );
    expect(projectedVerb(control)).toBe('POST');
    const id = control.operations?.[0].id as string;

    const rec: IRecorder = { events: [] };
    await invoke(
      ['run', '--source', source, '--type', 'rec', '--namespace', 'svc', '--opt', `http.verb.${id}=GET`],
      { rec: recordingPlugin('rec', rec) }
    );
    expect(projectedVerb(rec)).toBe('GET');
  });
});
