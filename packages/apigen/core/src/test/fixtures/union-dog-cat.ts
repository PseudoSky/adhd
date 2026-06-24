// Fixture: Dog | Cat discriminated union for union.spec.ts
//
// Models the canonical `Dog | Cat` example from DESIGN.md §4.1.
// Both variants carry a `kind` field with a literal const value used as the
// discriminant, plus their own payload field.
//
// This file is NOT imported at runtime by union.ts (which is pure schema
// building) — it serves as documentation for the schema structure that
// buildUnionSchema is meant to represent.

export class Dog {
  readonly kind = 'dog' as const
  constructor(public readonly name: string) {}
}

export class Cat {
  readonly kind = 'cat' as const
  constructor(public readonly lives: number) {}
}

/** Union type that union.ts's buildUnionSchema targets. */
export type Pet = Dog | Cat
