# pnpm release:dry (exit 130)

Command: pnpm release:dry
EXIT 130. First 40 lines of the failure (vitest policy:test, nx publish phase), then the failed-task summary.

```
⎯⎯⎯⎯⎯⎯ Failed Tests 13 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/unit/functional/review-fixes-entrypoint.spec.ts > Review fixes E1 / E13 - dist layout lookup, stale artifact warning, loadable version > a baked artifact is used only when it is current > E1 a freshly baked artifact is accepted
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ test/unit/functional/review-fixes-entrypoint.spec.ts:445:78
    443|       await scratch.with('e1-fresh', async (dir) => {
    444|         const inspected = await inspectChanged(dir, () => undefined);
    445|         expect('operations' in inspected && inspected.operations.lengt…
       |                                                                              ^
    446|       });
    447|     });
 ❯ test/unit/functional/review-fixes-entrypoint.spec.ts:443:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/13]⎯

 FAIL  test/unit/functional/review-fixes-entrypoint.spec.ts > Review fixes E1 / E13 - dist layout lookup, stale artifact warning, loadable version > a baked artifact is used only when it is current > E1 no operations is rejected with a reason
AssertionError: expected 'artifact was baked by extractor 0.3.6…' to match /holds no operations/

- Expected:
/holds no operations/

+ Received:
"artifact was baked by extractor 0.3.6, this install has 0.3.7"

 ❯ test/unit/functional/review-fixes-entrypoint.spec.ts:459:61
    457|         await scratch.with('e1-stale', async (dir) => {
    458|           const inspected = await inspectChanged(dir, row.change);
    459|           expect('reason' in inspected && inspected.reason).toMatch(ro…
       |                                                             ^
    460|         });
    461|       });
 ❯ test/unit/functional/review-fixes-entrypoint.spec.ts:457:9

```

Failed-task summary from the same run:

```
 NX   Running target publish for 69 projects and 831 tasks they depend on failed

Tasks not run because their dependencies failed or --nx-bail=true:

- backlog:publish
- decompile-cli:publish
- dispatch-cli:publish
- policy:publish

Failed tasks:

- policy:test
- backlog:test
- decompile-cli:test

```
