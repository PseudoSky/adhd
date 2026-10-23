// Fixture: intermediate hop in a two-hop re-export chain — see
// reexport-chain-outer.ts, which re-exports FROM this file (which itself
// re-exports from reexport-source.ts). Not extracted directly by any test;
// exists purely to give reexport-chain-outer.ts a second hop to resolve
// through.

export { sourceFn, sourceConst, SourceClass } from './reexport-source';
