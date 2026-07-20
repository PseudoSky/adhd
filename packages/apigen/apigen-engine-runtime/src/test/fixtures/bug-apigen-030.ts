// Regression fixture for BUG-APIGEN-030.
//
// `describePet` takes an inline discriminated union parameter (`Dog | Cat`),
// which `morph-walk.ts`'s union branch compiles to
// `{ oneOf: [...], discriminator: {...}, "x-apigen-logical": "union" }`
// (DESIGN §4.1 / BUG-APIGEN-019). Before the BUG-APIGEN-030 fix,
// `ajv.compile()` threw `strict mode: unknown keyword` on the composed
// schema for this operation — a 100%-failure-rate crash, not a validation
// rejection.
export interface Dog {
  kind: 'dog';
  name: string;
}

export interface Cat {
  kind: 'cat';
  lives: number;
}

export type Pet = Dog | Cat;

export function describePet(pet: Pet): string {
  return pet.kind === 'dog' ? `Dog: ${pet.name}` : `Cat: ${pet.lives} lives`;
}
