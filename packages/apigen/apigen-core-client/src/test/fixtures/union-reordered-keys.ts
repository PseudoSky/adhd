// Fixture for the reordered-key dedupe defect (review finding, MEDIUM;
// backlog 3a3e5884's follow-up).
//
// Two structurally-IDENTICAL interfaces, declared with their properties in a
// DIFFERENT order. Used INLINE as a union in both the parameter and return
// type, so extraction routes through morph-walk.ts's `walkType` union branch
// (Path 2) — never ts-json-schema-generator's Path 1, which cannot resolve the
// qualified `import("<abs>").TypeName` text a named-type parameter produces.
//
// The object branch builds `properties` (and `required`) in DECLARATION order,
// so the two branches are semantically the same schema but stringify
// differently — BOTH the `properties` object AND the `required` array are
// reordered. A dedupe keyed on raw `JSON.stringify` misses them, leaving a
// `oneOf` with two identical branches; AJV then rejects every value that
// matches both branches ("must match exactly one schema in oneOf", MCP
// -32602). `dedupeVariants`'s canonical comparison must collapse them to one.
export interface AlphaFirst {
  alpha: string;
  beta: number;
}

export interface BetaFirst {
  beta: number;
  alpha: string;
}

export async function reorderedKeys(
  ctx: unknown,
  input: AlphaFirst | BetaFirst
): Promise<AlphaFirst | BetaFirst> {
  void ctx;
  return input;
}
