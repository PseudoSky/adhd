// Fixture: `export * from './module.js'` wildcard re-export. Secondary to
// the named-re-export-list fix (the real-world repro case only used named
// lists), but ts-morph's `getExportedDeclarations()` flattens wildcard
// re-exports for free, so it's covered here too.

export * from './reexport-source';
