import { ApiError } from '@adhd/apigen-base-errors';
import * as core from '../core';
import type {
  Attributes,
  IAuditEntry,
  IDecision,
  IDoctorReport,
  IDraftOperation,
  IDraftOptions,
  IDraftPolicy,
  IEffectivePolicy,
  IExplanation,
  ILayerInput,
  INarrowOutcome,
  INarrowRequest,
  IResolved,
  IRuntimeValues,
  ICompileSummary,
  IVerifyReport,
} from '../spec';
import type { IPolicyCtx } from './ctx';
import { draftPolicy } from './draft';
import { verifyLayers } from './verify';

/** Input of `evaluate`, `check` and `explain`. */
export interface IEvaluateInput {
  /** Qualified tool name, as written in the policy's `tool` keys. */
  tool: string;
  /** The call's arguments. */
  args?: Record<string, unknown>;
  /** Supplied attributes of the caller (final; defaults fill the rest). */
  attributes?: Attributes;
  /** Runtime values supplied by the caller; wins over the ctx provider. */
  runtime?: IRuntimeValues;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCall(input: IEvaluateInput): void {
  if (input === null || typeof input !== 'object' || typeof input.tool !== 'string' || input.tool.trim() === '') {
    throw new ApiError('invalid_argument', 'tool must be a non-empty string');
  }
  if (input.args !== undefined && (input.args === null || typeof input.args !== 'object' || Array.isArray(input.args))) {
    throw new ApiError('invalid_argument', 'args must be an object');
  }
}

async function layersOf(ctx: IPolicyCtx, override: ILayerInput[] | undefined): Promise<readonly ILayerInput[]> {
  return override ?? (await ctx.layers());
}

/**
 * Compiles the layers (the ctx's, or `input.layers`) and summarises the result:
 * hashes, counts, declared attributes, every error and warning. A policy that
 * does not compile is reported with `ok: false`, not thrown.
 */
export async function compile(ctx: IPolicyCtx, input?: { layers?: ILayerInput[] }): Promise<ICompileSummary> {
  const layers = await layersOf(ctx, input?.layers);
  const result = core.compile(layers);
  if (!result.ok) {
    return {
      ok: false,
      compilerVersion: core.COMPILER_VERSION,
      permissionCount: 0,
      defaultsCount: 0,
      attributes: {},
      errors: result.errors,
      warnings: result.warnings ?? [],
    };
  }
  const { policy } = result;
  return {
    ok: true,
    compilerVersion: policy.compilerVersion,
    inputHash: policy.inputHash,
    contentHash: policy.contentHash,
    permissionCount: policy.permissions.length,
    defaultsCount: policy.defaults.length,
    attributes: policy.attributes,
    errors: [],
    warnings: result.warnings,
    policy,
  };
}

/**
 * Reports EVERY defect in the layers (the ctx's, or `input.layers`), never just
 * the first (D-05). A defective policy is a report with `ok: false`, which a
 * host maps to a non-zero exit; a policy file that cannot be read or parsed
 * fails the call with `internal`, naming the file.
 */
export async function verify(ctx: IPolicyCtx, input?: { layers?: ILayerInput[] }): Promise<IVerifyReport> {
  const layers = await layersOf(ctx, input?.layers);
  return verifyLayers(layers, { hasRuntimeProvider: ctx.runtime !== undefined });
}

/** Applies the policy defaults to the supplied attributes and reports where each value came from. */
export async function resolve(ctx: IPolicyCtx, input?: { attributes?: Attributes }): Promise<IResolved> {
  return core.resolve(await ctx.policy(), input?.attributes);
}

/**
 * Computes the attributes of a child that is handed less authority than its
 * parent: `grant` adds, `only` restricts, and widening is refused naming the
 * attribute and the rule. The parent is never changed.
 */
export async function narrow(
  ctx: IPolicyCtx,
  input: { parent?: Attributes; request: INarrowRequest }
): Promise<INarrowOutcome> {
  if (input === null || typeof input !== 'object' || input.request === null || typeof input.request !== 'object') {
    throw new ApiError('invalid_argument', 'request must be an object');
  }
  return core.narrow(await ctx.policy(), input.parent ?? {}, input.request);
}

async function observeRuntime(
  ctx: IPolicyCtx,
  input: IEvaluateInput,
  attributes: Attributes
): Promise<IRuntimeValues | undefined> {
  if (input.runtime !== undefined) return input.runtime;
  if (ctx.runtime === undefined) return undefined;
  try {
    return await ctx.runtime.observe({ scope: undefined, tool: input.tool, attributes });
  } catch {
    // Unobservable runtime values leave `runtime` undefined, so a permission that reads it denies `runtime-unavailable`.
    return undefined;
  }
}

/**
 * Decides one tool call: deny beats ask beats allow, and no match is deny.
 * Runtime values come from `input.runtime`, else one `observe` call on the ctx
 * provider. Records one redacted audit entry (names only) when the ctx has a
 * sink; a failing sink never changes the decision. A policy that cannot load
 * rejects (`internal`); it never allows.
 */
export async function evaluate(ctx: IPolicyCtx, input: IEvaluateInput): Promise<IDecision> {
  requireCall(input);
  const policy = await ctx.policy();
  const attributes = core.resolve(policy, input.attributes).attributes;
  const runtime = await observeRuntime(ctx, input, attributes);
  const decision = core.evaluate(policy, { tool: input.tool, args: input.args ?? {} }, input.attributes, runtime);
  if (ctx.audit !== undefined) {
    const entry: IAuditEntry = {
      at: ctx.now(),
      tool: input.tool,
      effect: decision.effect,
      matched: decision.matched,
      ...(decision.denial !== undefined ? { denialCode: decision.denial.code } : {}),
      attributeNames: Object.keys(attributes),
    };
    try {
      ctx.audit.record(entry);
    } catch {
      // The audit sink is observational; it can never alter or block a decision.
    }
  }
  return decision;
}

/**
 * Like `evaluate`, but anything other than `allow` throws
 * `ApiError('permission_denied', reason, { decision })` (D-04, D-15), so a host
 * pre-tool hook can key on the exit status alone. `ask` is reported as
 * `permission_denied` until the transport has an approval-required result.
 */
export async function check(ctx: IPolicyCtx, input: IEvaluateInput): Promise<IDecision> {
  const decision = await evaluate(ctx, input);
  if (decision.effect === 'allow') return decision;
  const reason =
    decision.denial?.reason ??
    (decision.effect === 'ask'
      ? `tool "${input.tool}" requires approval (matched ${decision.matched.join(', ')})`
      : `tool "${input.tool}" is denied`);
  throw new ApiError('permission_denied', reason, { decision });
}

/**
 * Decides one tool call and lists every permission considered for the tool:
 * which applied, whether context and arguments matched, and the arguments
 * after attribute substitution (D-12).
 */
export async function explain(ctx: IPolicyCtx, input: IEvaluateInput): Promise<IExplanation> {
  requireCall(input);
  const policy = await ctx.policy();
  const attributes = core.resolve(policy, input.attributes).attributes;
  const runtime = await observeRuntime(ctx, input, attributes);
  return core.explain(policy, { tool: input.tool, args: input.args ?? {} }, input.attributes, runtime);
}

/** Shows the effective policy: layer sources, effective attributes with provenance, and every permission. */
export async function show(ctx: IPolicyCtx, input?: { attributes?: Attributes }): Promise<IEffectivePolicy> {
  const layers = await ctx.layers();
  const policy = await ctx.policy();
  const resolved = core.resolve(policy, input?.attributes);
  return {
    sources: layers.map((layer) => ({ layer: layer.name, source: layer.source })),
    attributes: resolved.attributes,
    provenance: resolved.provenance,
    permissions: policy.permissions.map((permission) => ({
      id: permission.id,
      layer: permission.layer,
      tools: permission.tools,
      effect: permission.effect,
    })),
  };
}

/**
 * Checks that the policy tooling works here: the layer source is readable, the
 * layers compile, the settings resolve, and whether a runtime provider is
 * configured (informational). Never throws; every failure is a failed check.
 */
export async function doctor(ctx: IPolicyCtx): Promise<IDoctorReport> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let loaded = false;
  try {
    const layers = await ctx.layers();
    loaded = true;
    checks.push({ name: 'layer-source', ok: true, detail: `read ${layers.length} layer${layers.length === 1 ? '' : 's'}: ${layers.map((l) => l.source).join(', ')}` });
  } catch (error) {
    checks.push({ name: 'layer-source', ok: false, detail: describeError(error) });
  }
  if (loaded) {
    try {
      const policy = await ctx.policy();
      checks.push({ name: 'policy-compiles', ok: true, detail: `${policy.permissions.length} permissions, contentHash ${policy.contentHash}` });
    } catch (error) {
      checks.push({ name: 'policy-compiles', ok: false, detail: describeError(error) });
    }
  } else {
    checks.push({ name: 'policy-compiles', ok: false, detail: 'skipped: the layers could not be read' });
  }
  let settings: ReturnType<IPolicyCtx['describe']>['settings'] = {};
  let policySource = 'unknown';
  try {
    const described = ctx.describe();
    settings = described.settings;
    policySource = described.policySource;
    checks.push({ name: 'settings', ok: true, detail: `${Object.keys(settings).length} settings resolved` });
  } catch (error) {
    checks.push({ name: 'settings', ok: false, detail: describeError(error) });
  }
  checks.push({
    name: 'runtime-provider',
    ok: true,
    detail: ctx.runtime !== undefined ? 'configured' : 'none configured (informational: only runtime-reading permissions need one)',
  });
  return { ok: checks.every((c) => c.ok), checks, settings, policySource };
}

/**
 * Drafts a starting policy from a plain-data operation list (D-09, D-16): one
 * permission per operation, secret-path denies, and `inferred` notes for every
 * guess. Ignores the ctx (the parameter is named `ctx` because the apigen
 * extractor recognises the injected context by that exact name; any other name
 * would surface it as a command-line argument); the result always compiles.
 */
export async function draft(
  ctx: IPolicyCtx,
  input: { operations: IDraftOperation[]; options?: IDraftOptions }
): Promise<IDraftPolicy> {
  void ctx;
  if (input === null || typeof input !== 'object' || !Array.isArray(input.operations)) {
    throw new ApiError('invalid_argument', 'operations must be an array');
  }
  return draftPolicy(input);
}
