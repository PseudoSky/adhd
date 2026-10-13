import type { IPolicyIssue } from '../spec';

/**
 * Thrown by `loadCompiled` when a compiled policy cannot be trusted (CL-13).
 * `schema-version`: unknown `schemaVersion`; `hash-mismatch`: `contentHash` does
 * not match the content; `malformed`: not a compiled policy at all.
 */
export class PolicyLoadError extends Error {
  readonly code: 'schema-version' | 'hash-mismatch' | 'malformed';

  constructor(
    code: 'schema-version' | 'hash-mismatch' | 'malformed',
    message: string
  ) {
    super(message);
    this.name = 'PolicyLoadError';
    this.code = code;
  }
}

/**
 * Carries compile issues for callers that prefer an exception to an
 * `ICompileResult`. `compile` itself never throws on user input.
 */
export class PolicyCompileError extends Error {
  readonly issues: readonly IPolicyIssue[];

  constructor(issues: readonly IPolicyIssue[]) {
    const first = issues[0];
    super(
      first
        ? `${first.message} (${issues.length} issue${issues.length === 1 ? '' : 's'})`
        : 'policy failed to compile'
    );
    this.name = 'PolicyCompileError';
    this.issues = issues;
  }
}
