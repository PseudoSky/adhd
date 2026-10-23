# Spec 2f3dbebc — force-bundled @adhd/* dependencies (phantom runtime deps): ADR-level decision, question drafted

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 2f3dbebc-f509-4591-8c55-92bb00f8a2b3 (bug, HIGH, project adhd)
dor: needs-decision — check: the item itself says "this is a DELIBERATE policy ... fix direction: externalize OR keep + CI guard"; the choice changes the build output of ~31 packages and the publish/release model, so it is a repo-wide architecture decision (ADR) that this spec does not make. Size: M (either branch) after the decision.

## Observed facts (O = opened by architect; R = item only)
- O: `/Users/nix/dev/node/adhd/tools/vite-plugins/externalize.mjs:1-34` documents the policy: "`@adhd/*` package names themselves are never externalized" and the "RE-EXAMINE" paragraph (l.~29-36) states the original premise (no pnpm linking) no longer holds and the question is open and "deliberately left untouched".
- O: `externalizeRealDeps` is called from 31 `vite.config.*` files (rg). gx impact reports 0 callers (misses `.mjs` imports; do not read as LOW). `externalize.mjs` is also a workspace-wide cache input (`nx.json` `namedInputs.sharedGlobals`), so any edit invalidates every task cache.
- O: `compute-real-deps.js` walks transitive `@adhd/*` deps to externalize real npm deps and ALSO feeds each bundling package's `@nx/dependency-checks` `ignoredDependencies` (file header). Changing the policy changes both consumers — it is shared with spec fbbb1464 (lint cache inputs).
- O: `packages/apigen/apigen-engine-runtime/package.json:9` declares `"@adhd/apigen-base-logical": "^0.1.4"` (item observed `^0.1.2`; the range has since moved) while the published bundle inlines it (R: item's bundle inspection of 0.2.4; not re-verified against the current published tarball).
- O: related ADR: adhd 0003 (`@adhd/*` publishes CommonJS-only, `main` only, no `exports` map) — an externalized `require('@adhd/x')` resolves a CJS `main`, which is compatible; ADR-0003 TL;DR warns piecemeal ESM changes. adhd 0002 (fix at source): the harm is inertness of a base fix, a source-level defect of the build policy, not of the consumer.
- R: demonstrated harm (item): pinning base-logical had no effect until engine-runtime was rebuilt and republished (0.2.3 -> 0.2.4).
- Memory (project_nx_release_changed_only): `nx release` is changed-only; a bundled dependent is not republished when only its inlined dependency changes — this is the mechanism of the harm.

## The decision (do NOT implement until ruled)
Next ADR number: 0017 (existing 0001-0009, 0016). Draft question for `architect-decision` (one question, neutral framing, no preferred answer):

> ADR-0017 candidate — "Are `@adhd/*` workspace dependencies bundled into a package's published dist or resolved at install time?"
> Constraints in force: ADR-0003 (CJS-only publish), ADR-0002 (correct at source), pnpm links every workspace package into dependents' `node_modules` (verified in externalize.mjs header 2026-09-20), `nx release` changed-only, `verify-dist-load` gate, `@nx/dependency-checks` lint.
> Options to evaluate: (E) externalize `@adhd/*` (semver is real; a fix in a dependency reaches consumers without republishing dependents; consumers install more packages; every `@adhd/*` dep must be published and range-correct); (B) keep bundling + CI guard that fails when a bundled package's inlined `@adhd/*` dependency changed without the dependent being rebuilt/republished in the same release, plus stop declaring bundled `@adhd/*` as runtime `dependencies` (declare as devDependencies or an explicit `bundledDependencies` convention); (H) hybrid by tier: externalize `base`/`core` packages that carry runtime logic shared across hosts, bundle leaf entrypoints.
> Evidence needed before ruling: per-package list of which `@adhd/*` deps are inlined today (31 vite configs), published tarball sizes, whether every `@adhd/*` dependency of a published package is itself published at a compatible range, `nx release` behavior for dependents (`updateDependents`), and the cold-start cost of the extra installs. Not accepted as a rationale: "bundling is the historical policy" (premise superseded by pnpm linking, per externalize.mjs).
> Verdict space: APPROVE E | APPROVE B | APPROVE H | INSUFFICIENT (list missing evidence) | ESCALATE-ARCHITECT.

## Conditional specs (apply only after the ruling)
### If E: write-scope
/Users/nix/dev/node/adhd/tools/vite-plugins/externalize.mjs, tools/nx-plugins/deps/compute-real-deps.js (stop walking transitively through externalized `@adhd/*`), the 31 `vite.config.*` files only if they pass options, per-package `package.json` ranges, `tools/nx-plugins/deps/eslint-check.mjs`, `docs/decisions/0017-*.md`. ACs: AC1 a built dist of engine-runtime contains no inlined base-logical code and `require`s `@adhd/apigen-base-logical`; AC2 `verify-dist-load` passes for all 31; AC3 a base-logical runtime fix reaches a consumer by bumping only base-logical (consumer-outcome test in a temp project installing published-shape tarballs); AC4 lint `dependency-checks` clean without `ignoredDependencies` for `@adhd/*`.
### If B: write-scope
a new check under `tools/nx-plugins/build/` (CI guard), `externalize.mjs` header, per-package `package.json` dependency classification, `docs/decisions/0017-*.md`. ACs: AC1 guard fails when a bundled `@adhd/*` changed and its dependent was not rebuilt+versioned; AC2 bundled `@adhd/*` are not listed under runtime `dependencies`; AC3 doc states the declaration is build-time only.

## Test plan (tier per AC; cite `2f3dbebc AC<n>` after ruling)
AC1/AC4 (E) S over dist text scans + P for `verify-dist-load` (existing target; subprocess). AC3 (E) tier P with real `pnpm pack` tarballs in a temp dir (cannot be seen at S: needs the published layout, like `*.published-layout.e2e.ts` precedent). (B) guard: S with fixture workspaces, negative control = unmodified dependency passes.

## Risks / serialization
- Highest blast radius in the batch: every package build; all caches invalidate. Do not run in parallel with any spec touching `tools/nx-plugins/deps/**` (spec fbbb1464 — serialize fbbb1464 first; it is ready now).
- Open for user: rule on ADR-0017; until then do not change `externalize.mjs`.

## Product revision
dor (product): needs-decision (ADR-level, technical). Not decided by product. The drafted question above is forwarded to architect-decision verbatim (one question, neutral framing, verdict space APPROVE E | B | H | INSUFFICIENT | ESCALATE-ARCHITECT). Because the verdict space includes INSUFFICIENT, the evidence list in "Evidence needed" is to be gathered BEFORE dispatch (per-package inlined `@adhd/*` list for the 31 vite configs; published-range correctness; `updateDependents` behavior) or the one-shot will return INSUFFICIENT and spend the dispatch.
Product inputs (WHAT/WHY only): the harm is real and demonstrated (a base fix inert until the dependent is republished, 0.2.3 -> 0.2.4); the product requirement is "a fix in a dependency reaches consumers without republishing every dependent, or the release process makes that republish impossible to forget". Either E, B or H meets it; product has no preference among them.
Hard ordering: fbbb1464 first (both read `tools/nx-plugins/deps/**`). Do not touch `externalize.mjs` before the ruling.
Priority: P2 now (verdict + evidence gathering), implementation rank 8 (highest blast radius, cache-wide invalidation).
