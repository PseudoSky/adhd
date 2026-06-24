// Fixture: nominal class for nominal.spec.ts
//
// `User` is the canonical example from DESIGN.md §4.1.  It has:
//   - Two public fields (id: string, joinedAt: Date)
//   - A static `fromJSON` factory method (triggers x-apigen-ctor hint)
//   - An instance `toJSON` method   (triggers x-apigen-tojson hint)
//
// This file is imported by ts-morph during testing to enumerate method names;
// it is NOT imported at runtime by nominal.ts (which is pure-schema, no morph).

export class User {
  constructor(
    public readonly id: string,
    public readonly joinedAt: Date,
  ) {}

  static fromJSON(raw: { id: string; joinedAt: string }): User {
    return new User(raw.id, new Date(raw.joinedAt))
  }

  toJSON(): { id: string; joinedAt: string } {
    return { id: this.id, joinedAt: this.joinedAt.toISOString() }
  }
}
