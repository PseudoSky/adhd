# Browser Package Build Repair — `ui-react-base-hooks`

**State:** `browser-package-build-repair` (phase: intake)
**Branch:** `perf/nx-upgraded`
**Depends on:** `vite-cjs-import-meta-repair`

## Symptom

`./node_modules/.bin/nx build ui-react-base-hooks` printed `Found 4 errors` and exited
non-zero, emitting **no `dist/`** at all. While the build is red the package's bundle
tokens cannot be inspected, so the separate `import.meta.url` defect was unobservable
until this state landed.

## Root cause (measured)

The branch commit `chore(nx): upgrade Nx 18.3.4 -> 23.2.1` bumped `@types/react`
`18.2.33 -> 19.3.0`, and the package declares `react@19.3.0`. React 19's type
definitions made two breaking changes:

1. **Removed the zero-argument `useRef` overload.** `useRef<T>()` no longer compiles;
   a `useRef` call must now pass an initial value (`useRef<T | undefined>(undefined)`).
2. **`useRef<T>(null)` now returns `RefObject<T | null>`**, not `RefObject<T>` — the
   `current` field is nullable in the returned ref type.

The four `vite-plugin-dts` diagnostics were all in this one package:

| # | File:line | Code | Cause |
|---|-----------|------|-------|
| 1 | `src/lib/use-throttle/index.ts:16` | TS2554 | `useRef<NodeJS.Timeout>()` — zero-arg call |
| 2 | `src/lib/use-throttle/index.ts:19` | TS2554 | `useRef<Parameters<T>>()` — zero-arg call |
| 3 | `src/lib/use-throttle-state/index.ts:21` | TS2554 | `useRef<NodeJS.Timeout>()` — zero-arg call |
| 4 | `src/lib/use-infinite-scroll/index.ts:144` | TS2322 | returned `RefObject<HTMLElement \| null>` did not satisfy declared `RefObject<HTMLElement> \| RefObject<HTMLDivElement>` |

Blast radius was **bounded and verified, not assumed**: `nx run-many -t build` across the
66 JS/TS projects reported exactly one failing target, `ui-react-base-hooks:build`. Only
two workspace packages depend on React at all (`ui-react-base-hooks`, `decompile-cli`);
`decompile-cli` builds clean. A workspace-wide search found no external consumers of
`useInfiniteScroll` / `UseInfiniteScrollReturn`.

## Decision

Repair the **sources to conform to the installed React 19 types**. The installed runtime
is `react@19.3.0`; the types describe the runtime, so the code moves to the types, not
the reverse.

**Rejected alternatives:**

- **Downgrade `@types/react`.** Rejected: it would make the type-checker lie about the
  code it is checking, and desynchronise the declared types from the installed runtime.
- **Suppress the `vite-plugin-dts` diagnostics.** Rejected: it would ship a `.d.ts` set
  that does not match the package's own sources.
- **Build-flag workaround.** Rejected for the same reason — the diagnostics are real.

The public API shape is preserved: `useThrottle`, `useThrottleState` and
`useInfiniteScroll` keep their signatures and behaviour. This is a type-conformance
repair only.

## Changes

```diff
--- a/packages/ui-react/ui-react-base-hooks/src/lib/use-throttle/index.ts
+++ b/packages/ui-react/ui-react-base-hooks/src/lib/use-throttle/index.ts
@@ -16,7 +16,7 @@
-  const timeoutRef = useRef<NodeJS.Timeout>();
+  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
@@ -19 +19 @@
-  const lastArgsRef = useRef<Parameters<T>>();
+  const lastArgsRef = useRef<Parameters<T> | undefined>(undefined);
```

```diff
--- a/packages/ui-react/ui-react-base-hooks/src/lib/use-throttle-state/index.ts
+++ b/packages/ui-react/ui-react-base-hooks/src/lib/use-throttle-state/index.ts
@@ -21 +21 @@
-  const timeout = useRef<NodeJS.Timeout>();
+  const timeout = useRef<NodeJS.Timeout | undefined>(undefined);
```

```diff
--- a/packages/ui-react/ui-react-base-hooks/src/lib/use-infinite-scroll/index.ts
+++ b/packages/ui-react/ui-react-base-hooks/src/lib/use-infinite-scroll/index.ts
@@ -12 +12 @@
-  ref: RefObject<HTMLElement> | RefObject<HTMLDivElement>;
+  ref: RefObject<HTMLElement | null> | RefObject<HTMLDivElement | null>;
```

The `use-infinite-scroll` change is the declaration catching up to React 19's
`useRef<T>(null): RefObject<T | null>` return type; both union arms gained `| null` so
the declared shape stays otherwise identical. The internal `useRef<HTMLElement>(null)`
call site is already correct under React 19 and was not touched.

## Verification

Guard (RED before, GREEN after):

```
./node_modules/.bin/nx build ui-react-base-hooks \
&& test -f packages/ui-react/ui-react-base-hooks/dist/index.js \
&& test -f packages/ui-react/ui-react-base-hooks/dist/index.umd.js \
&& test -f packages/ui-react/ui-react-base-hooks/dist/index.mjs
```

- **Before:** `Found 4 errors`, non-zero exit, no `dist/`.
- **After:** `Successfully ran target build`, exit 0. All three published module formats
  emitted: `dist/index.js`, `dist/index.umd.js`, `dist/index.mjs` (plus `index.d.ts`).

No zero-argument `useRef` call remains in the three sources.

> **Out of scope, still open:** the build emits `[EMPTY_IMPORT_META]` for
> `src/lib/use-file-download/index.ts:48` under the `cjs`/`umd` formats — the separate
> `import.meta.url` bundle-token defect, repaired by the sibling
> `vite-cjs-import-meta-repair` state.
