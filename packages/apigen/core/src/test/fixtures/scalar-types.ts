// Fixture: scalar built-in types for logical-type schema extraction tests.
// Used by ts-json-schema.spec.ts to verify Date/bigint/Uint8Array/Buffer/URL/RegExp
// map to their canonical {type, format} schemas (BUG-APIGEN-005 / lt-extract-scalars).
//
// NOTE: keep this fixture free of external imports (e.g. decimal.js). Each
// `generateSchemas` call builds a fresh ts-json-schema-generator TS program;
// pulling in decimal.js's full .d.ts graph here multiplied per-export program
// creation into a ~90s-per-test stall. Decimal-bearing Map/Set/tuple cases live
// in `decimal-nested.ts` (a small fixture) instead.

export function returnsDate(label: string): Date {
  return new Date()
}

export function takesBigint(value: bigint): string {
  return value.toString()
}

export function takesUint8Array(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

export function takesBuffer(data: Buffer): string {
  return data.toString('base64')
}

export function takesURL(url: URL): string {
  return url.toString()
}

export function takesRegExp(pattern: RegExp): string {
  return pattern.source
}

export function takesString(value: string): string {
  return value
}

// BUG-APIGEN-011: readonly array forms must preserve element type
export async function echoReadonlyStringArray(xs: readonly string[]): Promise<readonly string[]> {
  return xs
}

export async function echoReadonlyNumberArray(xs: readonly number[]): Promise<readonly number[]> {
  return xs
}

export async function echoReadonlyArrayGeneric(xs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  return xs
}

export async function echoNestedReadonlyArray(xs: readonly string[][]): Promise<readonly string[][]> {
  return xs
}

// BUG-APIGEN-013: nested scalar types must preserve their format at any depth

/** Nested Date in object return: output.properties.at must be {type:string,format:date-time} */
export async function nestedDate(d: Date): Promise<{ at: Date; label: string }> {
  return { at: d, label: 'x' }
}

/** Date array return: output must be {type:array,items:{type:string,format:date-time}} */
export async function dateArray(d: Date): Promise<Date[]> {
  return [d]
}

/** Nested Date inside object with Date[]: both fields must have their formats */
export async function nestedDateAndArray(d: Date): Promise<{ at: Date; dates: Date[] }> {
  return { at: d, dates: [d] }
}

/** bigint param: input.properties.n must be {type:string,format:int64} */
export async function takesBigintParam(n: bigint): Promise<string> {
  return n.toString()
}

/** Nested bigint in object return: output.properties.n must be {type:string,format:int64} */
export async function nestedBigint(n: bigint): Promise<{ n: bigint; label: string }> {
  return { n, label: 'x' }
}

/** Nested Uint8Array in object: output.properties.data must be {type:string,format:byte} */
export async function nestedUint8Array(data: Uint8Array): Promise<{ data: Uint8Array; len: number }> {
  return { data, len: data.length }
}

/** Nested Buffer in object return: output.properties.data must be {type:string,format:byte} */
export async function nestedBuffer(data: Buffer): Promise<{ data: Buffer; len: number }> {
  return { data, len: data.length }
}

// REGRESSION GUARD (Map / Set / tuple): the BUG-013 anonymous-temp-file path
// expanded Map/Set to the class shape {type:object, properties:{size:number}},
// which rejects the canonical array wire. These must produce array-compatible
// schemas, with nested logical formats preserved inside them.

/** Map<number,string> param → array of [number,string] 2-tuples (NOT {size:number}) */
export async function echoMap(m: Map<number, string>): Promise<Map<number, string>> {
  return m
}

/** Set<string> param → array of strings (NOT {size:number}) */
export async function echoSet(s: Set<string>): Promise<Set<string>> {
  return s
}

/** [string,number,boolean] tuple param → positional array schema */
export async function echoTuple(t: [string, number, boolean]): Promise<[string, number, boolean]> {
  return t
}

/** Nested logical inside Map value: Map<string,Date> → value schema is date-time */
export async function mapDateValue(m: Map<string, Date>): Promise<Map<string, Date>> {
  return m
}

/** Nested logical inside tuple position: [Date, number] → position 0 is date-time */
export async function tupleDate(t: [Date, number]): Promise<[Date, number]> {
  return t
}

/** ReadonlyMap / ReadonlySet must behave like Map / Set */
export async function echoReadonlyMap(m: ReadonlyMap<number, string>): Promise<ReadonlyMap<number, string>> {
  return m
}

export async function echoReadonlySet(s: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  return s
}
