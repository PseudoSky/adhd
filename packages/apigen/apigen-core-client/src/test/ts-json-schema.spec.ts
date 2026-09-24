/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ts-json-schema.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer runs ts-json-schema-generator over real TypeScript (measured ~27s / 40 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `ts-json-schema.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: ts-json-schema", () => {
  it.todo("mocked: Date return type extracts as {type:string,format:date-time} (not {})");
  it.todo("mocked: plain string stays {type:string} with no format");
  it.todo("mocked: bigint param extracts as {type:string,format:int64}");
  it.todo("mocked: Uint8Array param extracts as {type:string,format:byte}");
  it.todo("mocked: Buffer param extracts as {type:string,format:byte}");
  it.todo("mocked: URL param extracts as {type:string,format:uri}");
  it.todo("mocked: RegExp param extracts as {type:string,format:regex}");
  it.todo("mocked: { at: Date } output → properties.at is {type:string,format:date-time}");
  it.todo("mocked: .negative — {} (dropped format) fails the test");
  it.todo("mocked: Date[] output → {type:array,items:{type:string,format:date-time}}");
  it.todo("mocked: { at: Date; dates: Date[] } → both fields have date-time format");
  it.todo("mocked: { n: bigint } output → properties.n is {type:string,format:int64}");
  it.todo("mocked: { data: Uint8Array } output → properties.data is {type:string,format:byte}");
  it.todo("mocked: { data: Buffer } output → properties.data is {type:string,format:byte}");
  it.todo("mocked: { cost: Decimal } → properties.cost is {type:string,format:decimal}");
  it.todo("mocked: second Decimal function → {type:string,format:decimal} (per-function not cached)");
  it.todo("mocked: { cost: D2 } → properties.cost is {type:string,format:decimal}");
  it.todo("mocked: { amounts: Decimal[] } → items is {type:string,format:decimal}");
  it.todo("mocked: { amounts: D2[] } via alias → items is {type:string,format:decimal}");
  it.todo("mocked: D2 top-level param → {type:string,format:decimal}");
  it.todo("mocked: plain {a:number,b:string} is unchanged");
  it.todo("mocked: readonly string[] param schema has items:{type:string} (not {})");
  it.todo("mocked: readonly string[] return type schema has items:{type:string}");
  it.todo("mocked: readonly number[] param schema has items:{type:number} (not {})");
  it.todo("mocked: ReadonlyArray<string> param schema has items:{type:string}");
  it.todo("mocked: readonly string[][] param schema has correct nested items");
  it.todo("mocked: plain number[] still yields items:{type:number}");
  it.todo("mocked: Map<number,string> → array of [number,string] 2-tuples (NOT {size:number})");
  it.todo("mocked: Map<number,string> output schema is array-compatible too");
  it.todo("mocked: Set<string> → array of strings (NOT {size:number})");
  it.todo("mocked: [string,number,boolean] → positional items array");
  it.todo("mocked: Map<string,Date> value schema is {type:string,format:date-time}");
  it.todo("mocked: Set<Decimal> element schema is {type:string,format:decimal}");
  it.todo("mocked: [Date,number] position 0 schema is {type:string,format:date-time}");
  it.todo("mocked: ReadonlyMap<number,string> behaves like Map");
  it.todo("mocked: ReadonlySet<string> behaves like Set");
  it.todo("mocked: the class-expansion {size:number} shape is the WRONG answer");
  it.todo("mocked: zod-internal definitions are stripped from $defs");
  it.todo("mocked: user schemas are fully inlined — no dangling $ref to removed definitions");
  it.todo("mocked: (teeth) a schema with a dangling $ref throws at generate time");
});
