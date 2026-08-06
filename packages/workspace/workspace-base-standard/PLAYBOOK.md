# Playbook — @adhd/workspace-base-standard

## Pre-merge

1. `npx nx lint workspace-base-standard` — must be clean.
2. `npx nx affected -t test --uncommitted` — must be green, including the
   real-fixture `checker.spec.ts` suite and the `provenance.spec.ts`
   round-trip suite.
3. `npx nx build workspace-base-standard` — must produce
   `dist/packages/workspace/workspace-base-standard/index.js` and
   `index.mjs`.
4. `npx nx affected -t verify-dist-load --uncommitted` — proves the built
   artifact actually `require()`/`import()`s, not just that source
   resolves.
5. Confirm zero dependents before merge (nothing should import
   `@adhd/workspace-base-standard` yet — the Nx adapter,
   `PKG-WS-NX-ADAPTER`, is the first real consumer and lands separately).

## Post-merge

1. Update `docs/contributing/conventions/package-naming.md` (or the
   relevant workspace-standard doc) once `PKG-WS-NX-ADAPTER` lands and
   actually wires these checks into a real Nx target — this package alone
   is the platform-agnostic core, not the enforcement point.
2. When `PKG-WS-NX-ADAPTER` starts depending on this package, re-run this
   package's `verify-dist-load` target to confirm nothing regressed for the
   new consumer.
3. If `.adhd/workspace.json`'s `boundaries.depConstraints` field is
   populated by `PKG-WS-NX-ADAPTER`, re-run `taxonomy.spec.ts` against the
   real repo config to confirm `readTaxonomy` still parses it correctly.
