/**
 * Internal barrel for the pure core. NOT an import path of the package; only
 * `service/` imports it.
 */
export { compile, COMPILER_VERSION } from './compile/compile';
export { loadCompiled } from './compile/load';
export { createPolicyMemo } from './memo/memo';
export type { IPolicyMemo } from './memo/memo';
export { PolicyLoadError, PolicyCompileError, PolicyEvalError } from './errors';
export { evaluate, evaluateDetailed } from './evaluate/evaluate';
export { explain } from './evaluate/explain';
export { resolveAttributes as resolve } from './attributes/resolve';
export { narrowAttributes as narrow } from './attributes/narrow';
export { LAYER_ORDER } from './compile/layers';
