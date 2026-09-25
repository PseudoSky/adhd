// Fixture for the co-resident-catch-all defect (backlog f58babc9) — the
// multi-catch-all variant of union-catchall.ts.
//
// `OnlyMethods` has NO data properties (a method is skipped by morph-walk.ts's
// object branch), so `walkType` emits the permissive `{}` for it. Unioned with
// a `Record<string, unknown>` (which emits `{type:'object',
// additionalProperties:{}}`) that is TWO distinct vacuous catch-alls in one
// union — exactly the shape b6a04e7f produces in the wild (the `{}` it emits
// for an imported optional object property, alongside an explicit Record
// catch-all). Used INLINE as both the parameter and return type, so extraction
// always routes through morph-walk.ts's `walkType` union branch (Path 2).
export interface Dog {
  kind: 'dog';
  bark: string;
}

export interface OnlyMethods {
  run(): void;
}

export async function classifyPetMulti(
  ctx: unknown,
  input: Dog | OnlyMethods | Record<string, unknown>
): Promise<Dog | OnlyMethods | Record<string, unknown>> {
  void ctx;
  return input;
}
