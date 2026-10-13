/**
 * stealth-browser/src/lib/runtime-deps.ts — compile-time declaration of the owned runtime packages.
 *
 * `@adhd/sox-store-adapter` (the capture sink; ESM-only, only ever reached through a lazy `import()`)
 * and `@adhd/sox-service-proxy` (the lifecycle reaper transport; CommonJS) are production
 * dependencies of this package and are kept external by `externalizeRealDeps` in vite.config.ts.
 * These type-only references make the dependency visible to the workspace dependency check and
 * erase to nothing at build time, so neither package is ever inlined into `dist/index.js`.
 */
export type StoreAdapterModule = typeof import('@adhd/sox-store-adapter')
export type ServiceProxyModule = typeof import('@adhd/sox-service-proxy')
