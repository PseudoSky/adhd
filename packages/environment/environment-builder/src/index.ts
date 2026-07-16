/**
 * `@adhd/environment-builder` — public API surface.
 *
 * Re-exports the full builder-engine pipeline (`yaml-parser`, `field-merge`,
 * `config-resolver`, `json-schema-gen`, `provenance`, `validation`,
 * `snapshot-writer`) plus the builder-facing `EnvironmentSnapshot<T>` class
 * and its `build()` factory (`environment-snapshot.ts`, `builder-snapshot-api`).
 */
export * from './yaml-parser';
export * from './field-merge';
export * from './config-resolver';
export * from './json-schema-gen';
export * from './provenance';
export * from './validation';
export * from './snapshot-writer';
export * from './environment-snapshot';
