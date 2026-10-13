import type { IAuditSink, ICompileSummary, IDecision, IDoctorReport, IDraftOperation, IDraftOptions, IDraftPolicy, IEffectivePolicy, IExplanation, ILayerInput, INarrowOutcome, INarrowRequest, IResolved, IRuntimeProvider, IVerifyReport, Attributes } from '../spec';
import * as api from './api';
import type { IEvaluateInput } from './api';
import { createMemoryCtx } from './ctx';
import type { IPolicyCtx } from './ctx';

/** The operation set bound to one ctx. */
export interface IPolicyClient {
  compile(input?: { layers?: ILayerInput[] }): Promise<ICompileSummary>;
  verify(input?: { layers?: ILayerInput[] }): Promise<IVerifyReport>;
  resolve(input?: { attributes?: Attributes }): Promise<IResolved>;
  narrow(input: { parent?: Attributes; request: INarrowRequest }): Promise<INarrowOutcome>;
  evaluate(input: IEvaluateInput): Promise<IDecision>;
  check(input: IEvaluateInput): Promise<IDecision>;
  explain(input: IEvaluateInput): Promise<IExplanation>;
  show(input?: { attributes?: Attributes }): Promise<IEffectivePolicy>;
  doctor(): Promise<IDoctorReport>;
  draft(input: { operations: IDraftOperation[]; options?: IDraftOptions }): Promise<IDraftPolicy>;
}

const isCtx = (value: unknown): value is IPolicyCtx =>
  typeof value === 'object' && value !== null && typeof (value as IPolicyCtx).policy === 'function';

/**
 * Binds each operation to a ctx. Accepts a ctx, or `{ layers }` (plus optional
 * ports) as shorthand for `createMemoryCtx`. Nothing is read until a method is called.
 */
export function createPolicyClient(
  source: IPolicyCtx | { layers: readonly ILayerInput[]; runtime?: IRuntimeProvider; audit?: IAuditSink; now?: () => number }
): IPolicyClient {
  const ctx = isCtx(source) ? source : createMemoryCtx(source);
  return {
    compile: (input = {}) => api.compile(ctx, input),
    verify: (input = {}) => api.verify(ctx, input),
    resolve: (input = {}) => api.resolve(ctx, input),
    narrow: (input) => api.narrow(ctx, input),
    evaluate: (input) => api.evaluate(ctx, input),
    check: (input) => api.check(ctx, input),
    explain: (input) => api.explain(ctx, input),
    show: (input = {}) => api.show(ctx, input),
    doctor: () => api.doctor(ctx),
    draft: (input) => api.draft(ctx, input),
  };
}
