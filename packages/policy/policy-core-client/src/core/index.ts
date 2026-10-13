/**
 * Internal barrel for the pure core. NOT an import path of the package; only
 * `service/` imports it.
 */
export { compile, COMPILER_VERSION } from './compile/compile';
export { loadCompiled } from './compile/load';
export { createPolicyMemo } from './memo/memo';
export type { IPolicyMemo } from './memo/memo';
export { PolicyLoadError, PolicyCompileError } from './errors';
