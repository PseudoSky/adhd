// Fixture for BUG-APIGEN-059: a union of two named interfaces plus a
// Record<string, unknown> catch-all, used INLINE as both the parameter and
// return type of an exported function — this always routes through
// morph-walk.ts's `walkType` union branch (Path 2), never
// ts-json-schema-generator's Path 1, because an inline (non-aliased) union
// type annotation is exactly the "anonymous structural shape" Path 2 exists
// to resolve (see morph-walk.ts's own module header comment).
export interface Dog {
  kind: 'dog';
  bark: string;
}

export interface Cat {
  kind: 'cat';
  meow: string;
}

export async function classifyPet(
  ctx: unknown,
  input: Dog | Cat | Record<string, unknown>
): Promise<Dog | Cat | Record<string, unknown>> {
  void ctx;
  return input;
}
