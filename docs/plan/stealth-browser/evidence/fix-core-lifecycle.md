# fix-core-lifecycle evidence

Backlog 86a2318f: `defaultReaperEntry` answered null when the module was loaded as ESM.

Fix: `src/lib/lifecycle/reaper-link.ts` adds `resolveReaperEntry({ filename?, moduleUrl? })`. A CJS JavaScript `__filename` (the built bundle) is the entry; otherwise (ESM, or CJS from TypeScript source) `createRequire(moduleUrl).resolve('@adhd/stealth-core-browser')` gives the built package entry. `defaultReaperEntry(source?)` returns a string or throws a REAPER_UNAVAILABLE `LifecycleError`; `createProxyReaperLink` catches it into `lastError()` (degraded mode). No `process.env`.

Spec: `test/unit/lifecycle/reaper-entry-resolution.spec.ts` resolves through a real throwaway `node_modules/@adhd/stealth-core-browser/dist/index.js` tree with Node's own `createRequire` (no mock of the fixed function, no subprocess, no network).

RED: on the untouched source the new spec ran 6 failed / 6; e.g. "ESM ... resolves the package entry" `AssertionError: expected '/Users/nix/dev/node/adhd/.worktrees/stealth-browser/packages/stealth/stealth-core-browser/src/lib/lifecycle/reaper-link.ts' to be '<tmp>/node_modules/@adhd/stealth-core-browser/dist/index.js'`; "ESM with an unresolvable package fails with a typed REAPER_UNAVAILABLE LifecycleError" `AssertionError: expected undefined to be an instance of LifecycleError`; "neither __filename nor a module URL" `expected function to throw an error, but it didn't`.

GREEN: after the fix `pnpm vitest run --root packages/stealth/stealth-core-browser test/unit/lifecycle/reaper-entry-resolution.spec.ts` passed 6 / 6; the lifecycle directory passes 261 / 261 (31 files). The built bundle answers `require('./dist/index.js').lifecycle.defaultReaperEntry()` with its own absolute `dist/index.js`.

Existing specs that relied on the null-returning `__filename` default (`degraded.spec.ts`, `no-respawn.spec.ts`, `reaper-link.spec.ts` default-entry case) now pass an explicit `entryPath` or assert the typed outcome.

EXIT pnpm nx run stealth-core-browser:lint: 0
EXIT pnpm nx run stealth-core-browser:typecheck: 0
EXIT pnpm nx run stealth-core-browser:typecheck-spec: 0
EXIT pnpm nx run stealth-core-browser:test: 0
EXIT pnpm nx run stealth-core-browser:build: 0
