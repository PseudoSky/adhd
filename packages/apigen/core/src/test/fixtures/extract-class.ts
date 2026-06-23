// Fixture: Class exports for extract-classes.spec.ts (SPEC §10).
//
// Exports:
//   - Counter (exported class with static + instance methods)
//   - _InternalHelper (non-exported class — must NOT be extracted)
//
// Counter members:
//   Static:
//     - Counter.create(initialValue: number) → Counter   (exported static)
//     - Counter._privateStatic() → void                  (must NOT be extracted — _-prefixed)
//   Instance (opt-in):
//     - constructor(initialValue: number)                 (extracted as kind:'constructor')
//     - increment(amount?: number) → number               (public — extracted)
//     - getValue() → number                               (public — extracted)
//     - reset() → void                                    (public — extracted, returns void)
//   Private (must NOT be extracted):
//     - private _log() → void                            (private TS modifier)
//
// The non-exported class verifies the "only exported classes" rule.

export class Counter {
  private _value: number

  constructor(initialValue: number) {
    this._value = initialValue
  }

  static create(initialValue: number): Counter {
    return new Counter(initialValue)
  }

  // _-prefixed — SPEC §3 opt-out; must NOT be extracted.
  static _privateStatic(): void {
    // intentionally left blank
  }

  increment(amount?: number): number {
    this._value += amount ?? 1
    return this._value
  }

  getValue(): number {
    return this._value
  }

  reset(): void {
    this._value = 0
  }

  dispose(): void {
    // lifecycle hook — called by InstanceRegistry on dispose
  }

  private _log(): void {
    // private method — must NOT be extracted
  }
}

// Not exported — must NOT produce any operations.
class _InternalHelper {
  compute(): number {
    return 42
  }
}
// Suppress "declared but never used" TS error — fixture only.
void (undefined as unknown as _InternalHelper)
