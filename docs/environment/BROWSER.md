# Browser usage of `@adhd/environment` — design note

> Companion to Gap Task **G-9** (`docs/environment/adoption-survey/GAP_SPECS.md`) — that
> document is the normative spec (interfaces, DoD, acceptance tests); this note is the
> longer-form rationale for *why* strategy (a)+(b) was chosen over the alternatives, so a
> future reviewer doesn't have to re-derive the trade-offs from scratch.

## 1. The constraint that decides everything

`@adhd/environment`'s value proposition (`ARCHITECTURE.md` §0/§2.1) is that the **whole
cascade resolves live**: code defaults → system/global/project/local files → env vars,
with scope auto-detected from `cwd`/`.git`/`.adhd` markers. Every one of those inputs is
**absent in a browser**:

| Cascade input | Node source | Browser equivalent |
|---|---|---|
| Code defaults | `EnvironmentSpec.config[*].default` | Same — this is plain data, ships fine. |
| System/global/project/local files | `fs.readFileSync` under `~/.adhd/…` / `<cwd>/.adhd/…` | **None.** No filesystem. |
| Env vars | `process.env` | **None.** No `process` global (unless a bundler polyfills it — don't rely on that). |
| Scope auto-detection | `.git`/`.adhd` marker search from `cwd` | **None.** No cwd. |
| `paths`/`files` (`DirSpec`/`FileSpec`) | Real filesystem paths | **None.** Meaningless in a browser. |
| `lock()` | `fs` advisory lock (`O_EXCL`) | No general primitive (Web Locks API exists but is a different model — see §4). |

**Conclusion: nothing in the resolution pipeline can run browser-side.** The only thing
that *can* cross the boundary is an already-resolved **result** — the `SnapshotData<T>`
shape the Node side already produces via `env.write()`. This single fact is what rules
option (c) out and makes (a)/(b) the only real candidates.

## 2. Options considered

### (a) Build-time resolution → embed the resolved snapshot into the bundle

The Node build step (or a dedicated CLI step, e.g. a future `environment-cli export-snapshot
--target browser`) runs `env.write()` (or the in-memory `SnapshotData` directly), and the
browser bundle imports it as static data:

```ts
// generated at build time, e.g. src/adhd-env.snapshot.ts
export const snapshot = { /* SnapshotData<T> */ } as const;
```
```ts
// browser app code
import { BrowserEnvironment } from '@adhd/environment-core-browser';
import { snapshot } from './adhd-env.snapshot';
const env = new BrowserEnvironment({ snapshot });
```

**Pros:** zero runtime cost, zero new I/O, ties directly into the existing `.write()`/
`fromSnapshot` design and the §2d cross-language seam (the browser becomes just another
snapshot consumer, same contract Python/Rust would use). Config is typed and tree-shakeable
if emitted as a `.ts` module rather than raw JSON.
**Cons:** frozen until the next build+deploy — no way to change config without shipping new
JS. This is the same characteristic every SPA's build-time env already has (Vite's
`import.meta.env`, webpack `DefinePlugin`), so it's not a regression — but it does mean (a)
alone can't answer "toggle a flag in prod without a redeploy."

### (b) A thin browser resolver reading an injected snapshot + a browser override source

Layer a **live** override channel on top of (a)'s embedded snapshot, sourced from
`window.__ADHD_ENV__` (a small JSON blob a server injects into `index.html` before the app
bundle loads — the same pattern as Google Analytics' `dataLayer` or Sentry's DSN injection)
and/or `localStorage` for local dev/experimentation:

```html
<script>window.__ADHD_ENV__ = { ADHD_APP_FEATURE_FLAG: "on" };</script>
<script src="/app.js"></script>
```

**Pros:** genuinely live — a server can rewrite that inline `<script>` per-request (e.g. from
its own already-resolved Node-side `Environment`) without rebuilding the JS bundle at all,
closing exactly the gap (a) alone leaves open. Mirrors G-7's `at:'runtime'` semantics with a
real live source instead of a fake one.
**Cons:** requires the hosting server to cooperate (inject the script) — a pure static-file
CDN deploy with no server-side templating can't use this channel and falls back to (a) alone.

**Explicitly rejected as the live source: `import.meta.env`.** Vite (and webpack's
`DefinePlugin`) *textually replace* `import.meta.env.X` at build time — it is normal
JavaScript **before** the bundler runs and a literal after. There is no way to make it "live"
without also making it lie about being build-time-safe (a bundler-level static-replacement
optimization other code may depend on, e.g. dead-code elimination of an `if (import.meta.env.DEV)`
branch). Using it as `BrowserEnvironment`'s live source would silently degrade back to (a)'s
behavior while claiming to be (b)'s.

### (c) A `platform:browser`-safe resolver that re-implements the cascade client-side

Rejected outright, not merely deprioritized. Per §1's table, there is no browser-native
substitute for `fs` (files), `os.homedir()` (global root), or a real `cwd` (scope
auto-detection) — a "browser resolver" would have nothing to resolve *from* except the same
already-resolved snapshot (a) already provides, plus whatever `window`/`localStorage` (b)
already provides. Building a parallel resolver here would be pure duplication with a
higher defect surface (a second cascade implementation to keep byte-for-byte compatible with
the Node one) for zero new capability over (a)+(b) combined.

## 3. Recommendation

**Ship (a) as the required baseline, (b) as the recommended live layer on top — never (c).**
This is exactly `environment-core-browser`'s `BrowserEnvironment` shape in Gap Task G-9: a
snapshot-reading class, `platform:browser`, depending only on `environment-base-spec`
(already zero-Node-built-in, `platform:shared`), with an optional `liveOverrideSource`
callback defaulting to `window.__ADHD_ENV__`.

## 4. What degrades, and how (see G-9 for the full table + DoD)

Summarized from the Gap Task's feature-degradation table: `at:'runtime'` fields re-read the
injected browser override source instead of `process.env`; `at:'build'`/`'fixed'` fields are
unaffected (already a single point-in-time resolution, which the embedded snapshot already
represents exactly); scope/cwd auto-detection is removed (the snapshot already encodes
whatever scope the Node build chose); `paths`/`files`/`ensureDirs()`/`write()`/`lock()` throw
`NotSupportedInBrowserError` rather than silently returning nonsense — a browser genuinely has
no filesystem, and pretending otherwise (e.g. resolving to `/undefined/...` under a broken
bundler polyfill) is a worse failure mode than a clear, named error. `lock()`'s advisory-file
model has no direct browser equivalent, but the **Web Locks API** (`navigator.locks.request`)
solves a *different* problem (mutual exclusion between browser tabs/workers of the same
origin) closely enough that it's worth flagging as a genuine, spec-able stretch goal — noted
in G-9 as explicitly deferred, not required for v1, because it changes the concurrency model
(promise-based, callback-scoped) rather than matching `lock()`'s synchronous
acquire/release-function shape 1:1.

**Secrets are the one non-negotiable, non-degrading boundary.** A `secret: true` field must
never reach a browser bundle in any form, embedded or live — `BrowserEnvironment` throws
`SecretNotAvailableInBrowserError` on access rather than returning even the redacted
`makeEnvRef` sentinel, foreclosing any future "helpful" live-resolution path for it.

## 5. Platform-isolation packaging

New package `environment-core-browser` — `domain:environment`, `pkg-kind:core`,
`platform:browser`. Depends only on `environment-base-spec` (`platform:shared`). Never
depends on `environment-builder`/`environment-core-node` (both `platform:node`) — enforced by
an ESLint import-restriction rule, not just this document, per `AGENTS.md` §3 ("NEVER import
Node internals... into `platform:browser`").
