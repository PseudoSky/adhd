// Fixture: single-hop re-export barrel over reexport-source.ts.
//
// Exercises `export { ... } from './module.js'` (the shape the old
// extractor explicitly skipped — see extract.ts's unified export-loop header
// comment): a plain re-export (sourceFn), a renamed re-export
// (sourceConst as barrelConst), a plain named-object re-export (sourceApi),
// and a plain class re-export (SourceClass — covers extract-classes.ts's
// equivalent fix).

export {
  sourceFn,
  sourceConst as barrelConst,
  sourceApi,
  SourceClass,
} from './reexport-source';
