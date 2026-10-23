/**
 * Policy document types (spec section 2). Pure types: this file imports nothing.
 */

/** The only supported policy document version. */
export type PolicyVersion = 1;

/** Attribute kinds. `name` is a single string; `names`/`paths` are string lists. */
export type AttributeKind = 'name' | 'names' | 'paths' | 'number';

/** A single attribute value: a name, a number, or a list of names/paths. */
export type AttributeValue = string | number | readonly string[];

/** The facts about a caller that a consumer supplies (AT-01). Optional everywhere (AT-09). */
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** `attributes:` block. Keys are attribute names. The whole block is optional. */
export type IAttributeDecl = Readonly<Record<string, AttributeKind>>;

/** `runtime:` block. The consumer-supplied fields the policy reads (RT-02). */
export type IRuntimeDecl = Readonly<Record<string, 'number' | 'name'>>;

/** Consumer-supplied, read-only (RT-01). */
export type IRuntimeValues = Readonly<Record<string, number | string>>;

/** A query-engine expression (QE-01). Placeholders `$attributes.*` appear as string leaves. */
export type FilterExpression = Readonly<Record<string, unknown>>;

/** One `defaults` rule. Matched against the supplied attributes; the last matching rule that sets an attribute wins (LY-01). */
export interface IDefaultsRule {
  /** Filter over the supplied attributes, same syntax as `context`. Omitted = every caller (LY-02). */
  readonly where?: FilterExpression;
  /** Values this rule sets. An explicit empty value stops inheritance (LY-04). */
  readonly set: Attributes;
}

/** The three decision effects. Deny beats ask beats allow (PM-06). */
export type Effect = 'allow' | 'ask' | 'deny';

/** One permission entry of a policy document. */
export interface IPermission {
  /** Tool name, list, or trailing-wildcard pattern (`files/*`; `files.*` is normalised to it). */
  readonly tool: string | readonly string[];
  /** Default `allow` (PM-05). */
  readonly effect?: Effect;
  /** Filter over `{ ...attributes, runtime }` (FX-05). */
  readonly context?: FilterExpression;
  /** Filter over the tool-call arguments (and `child.*` for child-creating tools). */
  readonly args?: FilterExpression;
  /** Argument values forced onto an allowed call. */
  readonly set?: Readonly<Record<string, unknown>>;
}

/** A policy document (one layer file, parsed to JSON). */
export interface IPolicyDocument {
  readonly version: PolicyVersion;
  readonly attributes?: IAttributeDecl;
  readonly runtime?: IRuntimeDecl;
  readonly defaults?: readonly IDefaultsRule[];
  readonly permissions: readonly IPermission[];
}

/** Layer names, in evaluation order. */
export type LayerName = 'global' | 'project' | 'local';

/** One layer handed to `compile`. */
export interface ILayerInput {
  readonly name: LayerName;
  /** Where it came from, for error messages and `explain`. */
  readonly source: string;
  /** Validated against the schema by compile. */
  readonly document: unknown;
}

/** A narrowing request for a child (spec section 2.2). */
export interface INarrowRequest {
  /** Added to inherited values (union), per attribute (MG-04). */
  readonly grant?: Attributes;
  /** Must lie within the add-step result; replaces it (MG-05). */
  readonly only?: Attributes;
  /** Supplied attributes of the child, matched by `defaults[].where` (for example `{ team: 'payments' }`). Final: `grant` and `only` cannot change them (AT-04). */
  readonly attributes?: Attributes;
}
