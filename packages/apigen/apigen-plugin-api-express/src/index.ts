export { apiExpressPlugin } from './lib/plugin';
export { default } from './lib/plugin';
// Public API parity with @adhd/apigen-plugin-api-fastify (whose index also
// re-exports `generate`/`run`). These were never re-exported here, which went
// unnoticed because Vite's CJS interop leaked `apiExpressPlugin`'s `generate`/
// `run` METHODS as named exports when the package resolved to its built
// `dist`. Under real source resolution (the test-time `nxViteTsPathsPre()`
// path) the named exports are genuinely absent, so consumers importing
// `{ run }` (e.g. apigen-cli's batch-plugin-e2e-express.spec.ts) got
// `undefined`. Re-export them explicitly.
export { generate } from './lib/generate';
export { run } from './lib/run';
