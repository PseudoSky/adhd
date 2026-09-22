# vite-plugins

Vite plugins (loaded by vite, NOT Nx). `externalize.mjs` = externalizeRealDeps bundling policy. `import-meta-url-cjs.mjs` = restores Rollup's `import.meta.url` CJS shim under Vite 8/Rolldown (BUG-BUILD-002; wire it into every CJS-emitting config). `copy-readme.mjs` = transitional (to be retired once @adhd/nx-assets covers it).
