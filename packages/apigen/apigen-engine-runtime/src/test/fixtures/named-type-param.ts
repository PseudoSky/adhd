// Regression fixture for BUG-APIGEN-026.
//
// Mirrors the real-world shape that broke: a plain named type alias (NOT a
// scalar apigen special-cases, NOT an inline/anonymous type) used as a
// function parameter. ts-json-schema-generator resolves this via Path 1
// (`schema-builders/ts-json-schema.ts`), which — before the BUG-APIGEN-026
// fix — always wrapped the result as `{ $ref: "#/definitions/Choice",
// definitions: { Choice: {...} } }` (ts-json-schema-generator's own
// `topRef: true` default). That whole fragment then landed nested inside the
// composed function schema (`properties.data.properties.choice`), where the
// `$ref`'s root-relative resolution permanently dangled once AJV compiled the
// full `input` schema — crashing EVERY call to `pick()`, not just ones with a
// particular value, since schema compilation itself failed before validation
// ever ran.
export type Choice = 'a' | 'b' | 'c'

export async function pick(choice: Choice): Promise<string> {
  return choice
}
