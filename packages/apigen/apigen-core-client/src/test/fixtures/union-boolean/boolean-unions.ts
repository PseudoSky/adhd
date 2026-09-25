// Fixture for the duplicated-`oneOf`-boolean defect (backlog 3a3e5884).
//
// ts-morph expands a `boolean` union member into its synthetic `true | false`
// literals. Under a STRICT tsconfig (`strictNullChecks: true`) an optional /
// nullable / union `boolean` therefore surfaces as multiple members that all
// map to `{type:'boolean'}`, producing `oneOf:[...,{boolean},{boolean}]` —
// unsatisfiable under AJV's exactly-one-match rule (MCP -32602).
//
// The interface is used as BOTH the parameter and the return type of an
// exported function: a NAMED interface used as a function parameter resolves
// to a qualified `import("<abs>").BooleanShapes` type text that
// ts-json-schema-generator (Path 1) cannot resolve, so extraction falls
// through to morph-walk.ts's `walkType` (Path 2) — the single emitter of the
// duplicate this fixture guards.
export interface BooleanShapes {
  /** Optional boolean — `[undefined, false, true]` under strictNullChecks. */
  managed?: boolean;
  /** Plain boolean — must stay a single, clean `{type:'boolean'}`. */
  plain: boolean;
  /** Explicit `boolean | undefined`. */
  maybe: boolean | undefined;
  /** `boolean | null`. */
  nullable: boolean | null;
  /** `string | boolean`. */
  textOrBool: string | boolean;
  /** `boolean | number`. */
  numOrBool: boolean | number;
  /** Literal union containing boolean. */
  litOrBool: 'x' | 'y' | boolean;
}

export async function booleanShapes(
  ctx: unknown,
  input: BooleanShapes
): Promise<BooleanShapes> {
  void ctx;
  return input;
}

// Fix 2 (backlog 2f5e64dc): a boolean-LITERAL union arm must keep its value.
// `true` alone is one branch (not a duplicate, so the collapse/dedupe above
// never touches it); a bare `{type:'boolean'}` would wrongly also accept
// `false`. A real `boolean` member still collapses to a bare branch — see the
// matrix above — so these two coexist to prove the distinction.
export interface LoneBooleanLiteralUnions {
  /** `true | 'x'` — the boolean arm must reject `false`. */
  trueOrString: true | 'x';
  /** `false | 1` — the boolean arm must reject `true`. */
  falseOrNumber: false | 1;
}

export async function loneBooleanLiterals(
  ctx: unknown,
  input: LoneBooleanLiteralUnions
): Promise<LoneBooleanLiteralUnions> {
  void ctx;
  return input;
}

/** Direct (non-object) union parameters — covers the input/param schema path. */
export async function directBooleanParams(
  ctx: unknown,
  on: boolean,
  maybeOn: boolean | undefined,
  label: string | boolean
): Promise<{ ok: boolean; detail: string | boolean }> {
  void ctx;
  return { ok: Boolean(maybeOn ?? on), detail: label };
}
