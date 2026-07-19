/**
 * `@adhd/environment-builder` — public API surface.
 *
 * The pure, zero-config-first live-resolve engine (ARCHITECTURE.md §4):
 * `scope` (active-scope resolution) → `roots` (directory-root resolution)
 * → `layer-files` (optional YAML overrides) → `config-resolver` (the
 * defaults→system→global→project→local→env cascade) → `dirs` (dir/file
 * catalog resolution) → `snapshot` (the top-level `buildSnapshot`/
 * `writeSnapshot` orchestrator). `validation`/`provenance`/`snapshot-writer`
 * are the salvaged supporting pipeline pieces.
 */
export * from './scope';
export * from './roots';
export * from './layer-files';
export * from './config-resolver';
export * from './dirs';
export * from './provenance';
export * from './validation';
export * from './snapshot-writer';
export * from './snapshot';
