# browser-package-build-repair — The public browser package builds again under the bumped toolchain

**Phase:** intake · **Kind:** work · **Depends on:** vite-cjs-import-meta-repair · **Guard:** `./node_modules/.bin/nx build ui-react-base-hooks && test -f packages/ui-react/ui-react-base-hooks/dist/index.js && test -f packages/ui-react/ui-react-base-hooks/dist/index.umd.js && test -f packages/ui-react/ui-react-base-hooks/dist/index.mjs`

---

## Goal

`./node_modules/.bin/nx build ui-react-base-hooks` exits 0 and emits all three module
formats. The public, publishable `@adhd/ui-react-base-hooks` package is no longer blocked
from release by the branch's toolchain upgrade.

---

## Semantic distillation

- **This is a separate state from the bundle-token repair on purpose.** The build is red
  today for a reason that has nothing to do with `import.meta.url`, and while it is red the
  bundles cannot be emitted at all — so the bundle-token defect is literally unobservable
  until this state lands. Splitting them keeps each guard's red attributable to one cause.
- **Root cause, measured.** The branch's `chore(nx): upgrade Nx 18.3.4 -> 23.2.1` commit
  bumped `@types/react` `18.2.33 → 19.3.0` (and the package declares `react@19.3.0`).
  React 19's type definitions removed the zero-argument `useRef` overload and changed
  `useRef<T>(null)` to return `RefObject<T | null>`. Four errors follow, all in this package:
  - `src/lib/use-throttle/index.ts:16` — `useRef<NodeJS.Timeout>()` (TS2554)
  - `src/lib/use-throttle/index.ts:19` — `useRef<Parameters<T>>()` (TS2554)
  - `src/lib/use-throttle-state/index.ts:21` — `useRef<NodeJS.Timeout>()` (TS2554)
  - `src/lib/use-infinite-scroll/index.ts:144` — returns `RefObject<HTMLElement | null>`
    where the declared return type wants `RefObject<HTMLElement> | RefObject<HTMLDivElement>`
    (TS2322)
- **Blast radius is bounded — verified, not assumed.** `nx run-many -t build` across the 66
  JS/TS projects reported exactly one failing target: `ui-react-base-hooks:build`. Only two
  workspace packages depend on react at all (`ui-react-base-hooks`, `decompile-cli`), and
  `decompile-cli` builds clean.
- **Downgrading `@types/react` is NOT an option.** `react@19.3.0` is the installed runtime;
  reverting the types would make the type-checker lie about the code it is checking. The
  source conforms to React 19, not the reverse.
- **Do not paper over it with a build flag.** Suppressing the `vite-plugin-dts` diagnostics
  would leave the package emitting a `.d.ts` set that does not match its own sources.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/BROWSER-BUILD-REPAIR.md"]
modified: ["packages/ui-react/ui-react-base-hooks/src/lib/use-throttle/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-throttle-state/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-infinite-scroll/index.ts"]
deleted:  []
```

---

## Commit points

- `fix(ui-react-base-hooks): conform the hooks to the installed React 19 types` — the three
  sources plus `BROWSER-BUILD-REPAIR.md`.
- The commit must leave the package's public API shape intact: this is a type-conformance
  repair, not a behaviour change. `useThrottle`, `useThrottleState` and
  `useInfiniteScroll` keep their signatures.

---
## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [browser-package-build-repair.1] The browser hooks package builds again under the installed React 19 types

- [browser-package-build-repair.2] All three published module formats are emitted by that build
- [browser-package-build-repair.3] The decision record attributes the build failure to the installed React 19 type packages
- [browser-package-build-repair.4] No zero-argument useRef call remains in the three failing sources
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "packages/ui-react/ui-react-base-hooks/package.json", "packages/ui-react/ui-react-base-hooks/project.json", "packages/ui-react/ui-react-base-hooks/vite.config.ts"]
mutates:    ["packages/ui-react/ui-react-base-hooks/src/lib/use-throttle/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-throttle-state/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-infinite-scroll/index.ts", "docs/plan/nx-23-upgrade/BROWSER-BUILD-REPAIR.md"]
```

---

## Notes for executor

The branch's React-19 type bump left `@adhd/ui-react-base-hooks` — a **public,
publishable** package — unable to build: four type errors, no `dist/` emitted, publish blocked.
This is a consequence of goal 1 (update Nx), exactly like the vite CJS breakage is a consequence
of goal 3 (vite to highest). Neither is a new goal.

Fix the source to conform to the **installed** React 19 types. Downgrading `@types/react` is
explicitly out of bounds — `react@19.3.0` is the runtime.

Red→green check: today `nx build ui-react-base-hooks` prints `Found 4 errors` and exits
non-zero, and no `dist/` directory is created. After this state it exits 0 and emits
`index.js` (CJS), `index.umd.js` and `index.mjs`.

Do **not** run `nx lint` on this package: `lint.dependsOn: ["sync-deps"]` and `sync-deps`
rewrites tracked `package.json` files. `graph-release-eslint-inferred` closes that separately.
