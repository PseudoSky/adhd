import { ApiError } from '@adhd/apigen-base-errors';
import { parseSourceSpec, resolveSource } from '@adhd/apigen-engine-gateway';
import { adaptCoreLayer, createInvoker, LayerContext } from '@adhd/apigen-engine-runtime';
import { createAttributesSource } from '../attributes-source';
import { splitPolicyArgv } from '../flags';
import { buildGate } from '../gate';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/**
 * `run bin:<cmd> [--spec f]... [--adhd-attributes v] -- args...` (argv excludes
 * the verb name). Steps: split the argv; parse the source (kind must be `bin`);
 * read the attributes once eagerly so a bad value refuses to start; build the
 * gate; resolve the source for `run` (nothing starts yet); invoke the argv
 * operation through the Layer stack. The child's stdout and stderr are
 * forwarded; its exit status is returned. A Layer refusal returns 3 with the
 * reason on stderr and the child is never started; an invalid argument 2;
 * anything else 1. The source is disposed in `finally`.
 */
export async function runVerb(argv: readonly string[], deps: IVerbDeps): Promise<number> {
  let dispose: (() => Promise<void>) | undefined;
  try {
    const split = splitPolicyArgv(argv);
    if (split.positionals.length !== 1) {
      throw new ApiError('invalid_argument', 'usage: adhd-policy run bin:<command> [--spec <file>]... [--adhd-attributes <json|@file>] -- <args>...');
    }
    const spec = parseSourceSpec(split.positionals[0] as string);
    if (spec.kind !== 'bin') {
      throw new ApiError('invalid_argument', 'run needs a bin:<command> source');
    }
    const attributes = createAttributesSource({
      ...(split.attributes !== undefined ? { flag: split.attributes } : {}),
      ...(deps.env['ADHD_POLICY_ATTRIBUTES'] !== undefined ? { env: deps.env['ADHD_POLICY_ATTRIBUTES'] } : {}),
      cwd: deps.cwd,
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    });
    await attributes.read();
    const gate = await buildGate({
      specFiles: split.specFiles,
      cwd: deps.cwd,
      attributes,
      onNote: (line) => deps.stderr(`${line}\n`),
    });
    const resolved = await resolveSource(spec, 'run', {
      cwd: deps.cwd,
      ...(deps.launcher !== undefined ? { launcher: deps.launcher } : {}),
    });
    dispose = resolved.dispose;
    const operation = resolved.operations[0];
    const fnName = operation?.path[operation.path.length - 1]?.raw;
    if (operation === undefined || fnName === undefined) {
      throw new ApiError('internal', 'the bin: source produced no operation');
    }
    const layers = gate.usePlugins.flatMap((plugin) => {
      const capability = plugin.capabilities?.layer;
      return capability ? [adaptCoreLayer(capability)] : [];
    });
    const result = (await createInvoker(layers)(
      fnName,
      {
        operation,
        ctx: new LayerContext(),
        envelope: {},
        domainArgs: { argv: [...split.childArgs], cwd: deps.cwd },
        transport: 'cli',
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      },
      {
        fns: resolved.pkg.fns,
        createClient: resolved.pkg.createClient as (envelope: Record<string, unknown>) => Promise<unknown>,
        schemas: resolved.pkg.schemas,
      }
    )) as { exitCode: number; stdout: string; stderr: string };
    if (result.stdout.length > 0) deps.stdout(result.stdout);
    if (result.stderr.length > 0) deps.stderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    return reportFailure(error, deps);
  } finally {
    await dispose?.().catch(() => undefined);
  }
}
