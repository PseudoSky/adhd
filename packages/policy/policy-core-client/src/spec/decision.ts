/**
 * Compile, decision, narrowing and explanation types (spec section 4.2).
 */
import type { ICompiledPolicy } from './compiled';
import type { Attributes, Effect, FilterExpression, LayerName } from './policy';

/** Options for `compile`. */
export interface ICompileOptions {
  /** Defaults to the package version. Part of the memo key. */
  readonly compilerVersion?: string;
}

/** One located authoring defect. */
export interface IPolicyIssue {
  readonly code:
    | 'schema'
    | 'unknown-operator'
    | 'unsupported-placeholder'
    | 'undeclared-attribute'
    | 'undeclared-runtime'
    | 'uncovered-narrowing'
    | 'layer-violation'
    | 'duplicate-id'
    | 'runtime-without-provider';
  /** JSON path into the offending layer document (CL-04). */
  readonly path: string;
  readonly layer?: LayerName;
  readonly message: string;
}

/** Result of the pure `compile`. */
export type ICompileResult =
  | { readonly ok: true; readonly policy: ICompiledPolicy; readonly warnings: readonly IPolicyIssue[] }
  | { readonly ok: false; readonly errors: readonly IPolicyIssue[]; /** Warnings found before the failure, so `verify` can report every issue (D-05). */ readonly warnings?: readonly IPolicyIssue[] };

/** A tool call to decide on. */
export interface IToolCall {
  /** Qualified tool name, as written in the policy's `tool` keys. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The outcome of evaluating a tool call. */
export interface IDecision {
  readonly effect: Effect;
  /** Forced argument values to merge into the forwarded call (CL-07). */
  readonly set: Readonly<Record<string, unknown>>;
  /** Permission ids that matched, in evaluation order. */
  readonly matched: readonly string[];
  /** Present when effect is `deny`: a stable code + human reason. */
  readonly denial?: {
    readonly code: 'explicit-deny' | 'no-match' | 'eval-error' | 'runtime-unavailable';
    readonly reason: string;
  };
}

/** Child attributes, or a refusal naming the attribute and the rule. */
export type INarrowResult =
  | { readonly ok: true; readonly child: Attributes }
  | { readonly ok: false; readonly variable: string; readonly rule: string; readonly reason: string };

/** The name the operation set uses for {@link INarrowResult}. */
export type INarrowOutcome = INarrowResult;

/** Effective attributes plus where each value came from. */
export interface IResolved {
  readonly attributes: Attributes;
  /** Where each effective value came from: `supplied` or a defaults rule id (EX-01). */
  readonly provenance: Readonly<Record<string, string>>;
}

/** A decision plus every permission considered for the tool. */
export interface IExplanation {
  readonly decision: IDecision;
  readonly considered: readonly {
    readonly id: string;
    readonly applicable: boolean;
    readonly contextMatched?: boolean;
    readonly argsMatched?: boolean;
    readonly substituted: FilterExpression | undefined;
  }[];
}
