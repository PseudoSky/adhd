# browser-package-build-repair — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** vite-cjs-import-meta-repair · **Guard:** `./node_modules/.bin/nx build ui-react-base-hooks && test -f packages/ui-react/ui-react-base-hooks/dist/index.js && test -f packages/ui-react/ui-react-base-hooks/dist/index.umd.js && test -f packages/ui-react/ui-react-base-hooks/dist/index.mjs`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [browser-package-build-repair.1] The browser hooks package builds again under the installed React 19 types

- [browser-package-build-repair.2] All three published module formats are emitted by that build
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "packages/ui-react/ui-react-base-hooks/package.json", "packages/ui-react/ui-react-base-hooks/project.json", "packages/ui-react/ui-react-base-hooks/vite.config.ts"]
mutates:    ["packages/ui-react/ui-react-base-hooks/src/lib/use-throttle/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-throttle-state/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-infinite-scroll/index.ts", "docs/plan/nx-23-upgrade/BROWSER-BUILD-REPAIR.md"]
```

---

## Notes for executor

The branch React-19 type bump left ui-react-base-hooks (public, publishable) unable to build: 4 type errors, no dist emitted, publish blocked. Fix the source to conform to the INSTALLED React 19 types; downgrading @types/react is not an option. This state must land before the bundle-token state, because the build failure makes the bundle unobservable.
