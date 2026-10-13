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

/**
 * Thrown by core operations that cannot decide because a rule could not be
 * evaluated (an uncompilable regular expression, an engine error). `evaluate`
 * catches it and denies `eval-error`; operations that return data (`resolve`,
 * `show`) surface it to the caller, who must treat it as a failure, never as
 * "the rule did not apply".
 */
export class PolicyEvalError extends Error {
  /** Id of the permission or defaults rule that could not be evaluated. */
  readonly ruleId: string;

  constructor(ruleId: string, message: string) {
    super(message);
    this.name = 'PolicyEvalError';
    this.ruleId = ruleId;
  }
}

/** Short, single-line description of a thrown value for a denial reason. */
export function describeThrown(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n')[0];
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
