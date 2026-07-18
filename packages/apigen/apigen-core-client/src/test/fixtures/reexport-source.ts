// Fixture: re-export source — real, physically-declared exports exercised
// INDIRECTLY through the barrel fixtures (reexport-barrel.ts,
// reexport-mid.ts, reexport-chain-outer.ts, reexport-wildcard-barrel.ts).
//
// Mirrors the shapes already covered by extract-named-fn.ts /
// extract-named-const.ts / extract-named-object.ts / extract-class.ts so the
// barrel-fixture tests can assert a re-exported operation is named/shaped
// identically to running `extract()`/`extractClasses()` directly against
// this file.

export function sourceFn(x: number): number {
  return x + 1;
}

export const sourceConst = (x: number, weight: number): number =>
  x * weight;

export const sourceApi = {
  getThing: (id: string): { id: string } => ({ id }),
};

export class SourceClass {
  private _value: number;

  constructor(initialValue: number) {
    this._value = initialValue;
  }

  static create(initialValue: number): SourceClass {
    return new SourceClass(initialValue);
  }

  increment(amount?: number): number {
    this._value += amount ?? 1;
    return this._value;
  }
}
