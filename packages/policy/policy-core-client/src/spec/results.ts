/**
 * Operation result types (the spec left these open; INTERFACES.md D-05, D-09).
 */
import type { ICompiledPolicy } from './compiled';
import type { IPolicyIssue } from './decision';
import type { AttributeKind, Attributes, Effect, IPolicyDocument, LayerName } from './policy';

/** Result of `compile`. `policy` is present exactly when `ok` is true. */
export interface ICompileSummary {
  readonly ok: boolean;
  readonly compilerVersion: string;
  readonly inputHash?: string;
  readonly contentHash?: string;
  readonly permissionCount: number;
  readonly defaultsCount: number;
  readonly attributes: Readonly<Record<string, AttributeKind>>;
  readonly errors: readonly IPolicyIssue[];
  readonly warnings: readonly IPolicyIssue[];
  readonly policy?: ICompiledPolicy;
}

/** Result of `verify`: every defect, never just the first (D-05). */
export interface IVerifyReport {
  /** True iff `errors` is empty. */
  readonly ok: boolean;
  readonly errors: readonly IPolicyIssue[];
  readonly warnings: readonly IPolicyIssue[];
  /** Layer sources that were read, in layer order. */
  readonly sources: readonly string[];
}

/** Result of `show`. */
export interface IEffectivePolicy {
  readonly sources: readonly { readonly layer: LayerName; readonly source: string }[];
  /** Effective, after defaults. */
  readonly attributes: Attributes;
  readonly provenance: Readonly<Record<string, string>>;
  readonly permissions: readonly {
    readonly id: string;
    readonly layer: LayerName;
    readonly tools: readonly string[];
    readonly effect: Effect;
  }[];
}

/** Result of `doctor`. `settings` shows each resolved setting and the cascade level it came from. */
export interface IDoctorReport {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
  readonly settings: Readonly<Record<string, { readonly value: unknown; readonly source: string }>>;
  /** Path of the discovered layer file(s) or 'built-in'. */
  readonly policySource: string;
}

/** One redacted audit record (AU-01). Attribute VALUES are never recorded, names only. */
export interface IAuditEntry {
  /** `ctx.now()`. */
  readonly at: number;
  readonly tool: string;
  readonly effect: Effect;
  readonly matched: readonly string[];
  readonly denialCode?: 'explicit-deny' | 'no-match' | 'eval-error' | 'runtime-unavailable';
  readonly attributeNames: readonly string[];
  readonly transport?: string;
}

/** Plain-data view of one foreign operation; the client imports no apigen type (SRC-11). */
export interface IDraftOperation {
  readonly name: string;
  readonly args: readonly {
    readonly name: string;
    readonly type: string;
    readonly kind?: string;
    readonly provenance?: 'declared' | 'inferred';
  }[];
  readonly hints?: { readonly readOnly?: boolean; readonly destructive?: boolean };
}

/** Options for `draft`. */
export interface IDraftOptions {
  /** Label used in comments/messages. */
  readonly source: string;
  /** Replaces the built-in secret list when set (LIKE-style patterns: `%` matches any run of characters, `_` is a literal underscore). */
  readonly secretPatterns?: readonly string[];
  /** Default 'read_roots'. */
  readonly readRootsAttribute?: string;
  /** Default 'write_roots'. */
  readonly writeRootsAttribute?: string;
}

/** One value `draft` had to guess (D-09). */
export interface IInferredEntry {
  readonly operation: string;
  readonly argument: string;
  readonly kind: string;
  readonly reason: string;
}

/** Result of `draft`. */
export interface IDraftPolicy {
  readonly document: IPolicyDocument;
  readonly yaml: string;
  readonly inferred: readonly IInferredEntry[];
}
