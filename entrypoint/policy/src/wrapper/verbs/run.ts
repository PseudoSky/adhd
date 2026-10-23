import { ApiError } from '@adhd/apigen-base-errors';
import { resolveSourceReference } from '@adhd/apigen-core-client';
import { nodeSourceProbe, resolveSource } from '@adhd/apigen-engine-gateway';
import { buildOpPlan, createPackageInvoker, dispatchForPlan, type InvokeOptions } from '@adhd/apigen-engine-runtime';
import { attributesFromFlags } from '../attributes-from-flags';
import { splitPolicyArgv } from '../flags';
import { buildGate } from '../gate';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/**
 * `run bin:<cmd> [--spec f]... [--adhd-attributes v] -- args...` (argv excludes
 * the verb name). Steps: split the argv; classify the source with the core
 * `resolveSourceReference` (it must name an executable); read the attributes
 * once eagerly so a bad value refuses to start; build the gate; resolve the
 * source for `run` (nothing starts yet); plan the argv operation with
 * `buildOpPlan` (transport `cli`) and dispatch it with `dispatchForPlan` through
 * the composed `createPackageInvoker` stack (tracing, attributes, policy, then
 * the central validate-Layer). The child's stdout and stderr are
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
    const reference = resolveSourceReference(split.positionals[0] as string, nodeSourceProbe);
    if (!reference.ok) throw new ApiError('invalid_argument', reference.error.message);
    if (reference.value.asset !== 'executable') {
      throw new ApiError('invalid_argument', 'run needs a bin:<command> source');
    }
    if (split.name !== undefined) {
      throw new ApiError('invalid_argument', '--name applies to serve only');
    }
    const attributes = await attributesFromFlags(split, deps);
    const gate = await buildGate({
      specFiles: split.specFiles,
      cwd: deps.cwd,
      ...(deps.home !== undefined ? { stopAt: deps.home } : {}),
      attributes,
      onNote: (line) => deps.stderr(`${line}\n`),
    });
    const resolved = await resolveSource(reference.value, {
      intent: 'run',
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.launcher !== undefined ? { launcher: deps.launcher } : {}),
    });
    dispose = resolved.dispose;
    const operation = resolved.operations[0];
    const fnName = operation?.path[operation.path.length - 1]?.raw;
    const schema = fnName === undefined ? undefined : resolved.pkg.schemas[fnName];
    const fn = fnName === undefined ? undefined : resolved.pkg.fns[fnName];
    if (operation === undefined || schema === undefined || fn === undefined) {
      throw new ApiError('internal', 'the bin: source produced no operation');
    }
    // The invoker and the validate-Layer look the operation up by its id, not by the raw function name the source keys its tables by.
    const schemas = { [operation.id]: schema };
    const invokeOptions: InvokeOptions = {
      fns: { [operation.id]: fn },
      schemas,
      createClient: resolved.pkg.createClient as NonNullable<InvokeOptions['createClient']>,
    };
    const plan = buildOpPlan({ op: operation, schema, transport: 'cli' });
    const invoke = createPackageInvoker(schemas, gate.usePlugins, { layerOptions: {} });
    const result = (await dispatchForPlan(
      plan,
      invoke,
      {
        envelope: {},
        domainArgs: { argv: [...split.childArgs], cwd: deps.cwd },
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      },
      invokeOptions
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
