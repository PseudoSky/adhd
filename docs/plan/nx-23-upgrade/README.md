# Nx 23 / Vite 8 upgrade, task-graph remodel, and file-level test selection

Land the Nx 23.2.1 + Vite 8 upgrade on perf/nx-upgraded, remodel the task graph onto inferred targets, and deliver fail-safe file-level test selection.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **(structural) The workspace runs the latest published Nx 23 line with the matching first-party plugin line, and the three test targets that failed the commit gate after the bump have a recorded verdict. (structural)** — (structural) The workspace runs the latest published Nx 23 line with the matching first-party plugin line, and the three test targets that failed the commit gate after the bump have a recorded verdict..

- `[dod.2]` **(structural) The test runner sits at the highest major its Nx peer range permits, and the ceiling blocking the next major is recorded with the evidence that establishes it. (structural)** — (structural) The test runner sits at the highest major its Nx peer range permits, and the ceiling blocking the next major is recorded with the evidence that establishes it..

- `[dod.3]` **A developer can build any workspace package and the build still type-checks it. (behavioral)** — A developer can build any workspace package and the build still type-checks it..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy`
  - observable: `exit 0, and the same build turns non-zero after a deliberately injected type error`
  - negative-control: `printf '\n\nexport const __shimProbe: number = "not a number";\n' >> packages/agent/agent-base-types/src/index.ts`
  - delivered-by: `tsconfig-shim-removal`

- `[dod.4]` **(structural) No migration-only compiler relaxation remains in the shared compiler configuration. (structural)** — (structural) No migration-only compiler relaxation remains in the shared compiler configuration..

- `[dod.5]` **A developer can change one source file and run only the tests that actually cover it, instead of the whole package suite. (behavioral)** — A developer can change one source file and run only the tests that actually cover it, instead of the whole package suite..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts`
  - observable: `exit 0 and a selected spec-file count strictly smaller than that package full suite`
  - delivered-by: `test-changed-optin`

- `[dod.6]` **When a change selects no tests, the fast path fails loudly rather than reporting success. (behavioral)** — When a change selects no tests, the fast path fails loudly rather than reporting success..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `pnpm run test:related -- packages/data/data-base-transforms/src/index.ts`
  - observable: `a non-zero exit and a message naming zero selected tests`
  - delivered-by: `test-changed-optin`
