/**
 * stealth-core-browser/src/lib/runtime-deps.ts — compile-time declaration of the owned runtime packages.
 *
 * `@adhd/sox-store-adapter` (the capture sink; ESM-only) is loaded at runtime only through the lazy `import()` in
 * `recording/open-store-sink.ts`; every other file refers to it with erased `import type`. It is a production dependency of this package and is kept external by `externalizeRealDeps` in
 * vite.config.ts. This type-only reference makes the dependency visible to the workspace dependency
 * check and erases to nothing at build time, so the package is never inlined into `dist/index.js`.
 * (The lifecycle reaper transport is imported statically by `lifecycle/sp.ts`, its only import site.)
 */
export type StoreAdapterModule = typeof import('@adhd/sox-store-adapter')
