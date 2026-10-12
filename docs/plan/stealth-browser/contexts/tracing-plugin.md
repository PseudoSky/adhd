# tracing-plugin — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-hosts · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-plugin`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The apigen tracing plugin is mounted on every host under the `adhd` namespace, configured in exactly one place, mirroring `entrypoint/backlog/src/tracing.ts`. Records are named `adhd.<op>.start|finish|error`, never `apigen.<op>...`.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/tracing.ts`; MODIFY `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts`, `entrypoint/stealth-browser/package.json`.

- **Reference Pattern:** `entrypoint/backlog/src/tracing.ts` (`makeTracingPlugin({ serviceName: 'adhd' })`), `entrypoint/backlog/src/server.tracing-required.spec.ts`, `server.tracing-six-tags.spec.ts` ([ref:backlog-tracing]); `packages/apigen/apigen-plugin-tracing/README.md`.

- **Delta Spec:** `src/tracing.ts`: `import { makeTracingPlugin } from '@adhd/apigen-plugin-tracing'; export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' });`. In `server.ts` and `cli.ts` import `tracingPlugin` from `./tracing.js` and include it in EVERY `usePlugins` array. NEVER import the package's own `tracingPlugin` singleton (that one is apigen-namespaced and would emit `apigen.*`). `serviceName` appears in no other non-test file. package.json adds `@adhd/apigen-plugin-tracing` and `@adhd/sox-telemetry` (workspace ranges matching backlog).

- **Invariants:** [inv:trace-namespace]: namespace `adhd`, one configuration site, every host mounted. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tracing-plugin]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-plugin` — runs every acceptance criterion below (red until the work is done); `--only tracing-plugin.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tracing-plugin --only tracing-plugin.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tracing-plugin.1] src/tracing.ts configures `makeTracingPlugin({ serviceName: 'adhd' })` and exports `tracingPlugin`.

- [tracing-plugin.2] NO source file imports the apigen-namespaced `tracingPlugin` singleton from @adhd/apigen-plugin-tracing (only makeTracingPlugin).
- [tracing-plugin.3] Every `usePlugins` array in src/server.ts and src/cli.ts (>=2 mounts) contains `tracingPlugin` imported from './tracing.js'.
- [tracing-plugin.4] package.json depends on @adhd/apigen-plugin-tracing and @adhd/sox-telemetry (workspace-resolved ranges).
---

## Reservations

```text
read_only:  ["entrypoint/backlog/src/tracing.ts", "packages/apigen/apigen-plugin-tracing/"]
mutates:    ["entrypoint/stealth-browser/src/tracing.ts", "entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/package.json"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/tracing.ts`. Modified: server.ts, cli.ts, package.json. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tracing-plugin]`:

- [ ] After tracing.ts and the mounts -- commit: `feat(stealth-browser): mount apigen tracing under adhd namespace [psm:tracing-plugin]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Backlog item 5b98d3b2 (FEAT-AGENT-TRACING) is a different feature (agent-session tracing dashboards) and is OUT of scope; this state only wires the apigen plugin the request asked for.
- The binary namespace proof is the NEXT concern (`tracing-namespace-proof`), after e2e (it flips tracing.ts temporarily and must not race a build).
