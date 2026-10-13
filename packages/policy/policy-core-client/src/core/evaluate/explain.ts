import type { Attributes, ICompiledPolicy, IExplanation, IRuntimeValues, IToolCall } from '../../spec';
import { evaluateDetailed } from './evaluate';

/**
 * Explains a decision (CL-11, EX-02, D-12): the decision plus EVERY permission
 * selected by tool name, with whether its context matched, whether its args
 * matched, and its args after placeholder substitution.
 */
export function explain(
  policy: ICompiledPolicy,
  call: IToolCall,
  attributes?: Attributes,
  runtime?: IRuntimeValues
): IExplanation {
  return evaluateDetailed(policy, call, attributes, runtime);
}
