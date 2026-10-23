// Fixture: two-hop re-export chain —
//   reexport-chain-outer.ts (this file) → reexport-mid.ts → reexport-source.ts
// with a rename applied at the OUTER hop only. Verifies the extractor
// resolves multi-hop barrel chains (not just a single hop) and always names
// the operation by the OUTERMOST exported alias — the alias closest to the
// entry file — never an intermediate-hop name.

export {
  sourceFn as outerFn,
  sourceConst as outerConst,
  SourceClass as OuterClass,
} from './reexport-mid';
