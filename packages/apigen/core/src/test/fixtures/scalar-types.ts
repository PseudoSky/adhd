// Fixture: scalar built-in types for logical-type schema extraction tests.
// Used by ts-json-schema.spec.ts to verify Date/bigint/Uint8Array/Buffer/URL/RegExp
// map to their canonical {type, format} schemas (BUG-APIGEN-005 / lt-extract-scalars).

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
