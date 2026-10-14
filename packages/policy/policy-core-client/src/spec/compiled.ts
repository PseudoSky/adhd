/**
 * Compiled policy types (spec section 3): what a deployer may store as a
 * precompiled artifact and what consumers load.
 */
import type {
  AttributeKind,
  Attributes,
  Effect,
  FilterExpression,
  IRuntimeDecl,
  LayerName,
} from './policy';

/** The compiled, indexed, hash-stamped form of one or more policy layers. */
export interface ICompiledPolicy {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  /** sha256 over canonical JSON of the sorted layer inputs + compilerVersion (CC-01). */
  readonly inputHash: string;
  /** sha256 over this object with `contentHash` omitted; verified on load (CL-13). */
  readonly contentHash: string;
  readonly attributes: Readonly<Record<string, AttributeKind>>;
  readonly runtime: IRuntimeDecl;
  /** `defaults` rules in evaluation order: layer order, then file order (LY-01). */
  readonly defaults: readonly ICompiledDefaultsRule[];
  /** Permissions in layer order, pre-indexed for lookup (below). */
  readonly permissions: readonly ICompiledPermission[];
  /** tool name -> indexes into `permissions`; patterns in `patterns`. */
  readonly index: {
    readonly exact: Readonly<Record<string, readonly number[]>>;
    readonly patterns: readonly { readonly prefix: string; readonly rules: readonly number[] }[];
  };
  /** Attributes for which a narrowing check exists on child-creating tools (NR-04 coverage set). */
  readonly narrowingCovered: Readonly<Record<string, readonly string[]>>;
}

/** One flattened `defaults` rule. */
export interface ICompiledDefaultsRule {
  /** `<layer>:<n>`, kept for provenance in explain (EX-01). */
  readonly id: string;
  readonly layer: LayerName;
  readonly source: string;
  readonly where: FilterExpression | undefined;
  readonly set: Attributes;
}

/** One flattened permission. */
export interface ICompiledPermission {
  /** `<layer>:<n>` stable id used in decisions and logs. */
  readonly id: string;
  readonly layer: LayerName;
  readonly tools: readonly string[];
  readonly effect: Effect;
  readonly context: FilterExpression | undefined;
  /** Placeholders pre-parsed to paths so substitution is a lookup, not a parse. */
  readonly args: FilterExpression | undefined;
  /** For example `['attributes.read_roots']`. */
  readonly placeholders: readonly string[];
  readonly set: Readonly<Record<string, unknown>> | undefined;
  readonly usesWithin: boolean;
  /** True when `context` reads `runtime.*`; drives RT-09 and the `verify` warning. */
  readonly readsRuntime: boolean;
}
