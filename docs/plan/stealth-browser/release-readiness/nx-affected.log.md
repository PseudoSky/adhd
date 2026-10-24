# nx affected (exit 1)

Command: npx nx affected --base=origin/main --head=HEAD --target=test (flags from .githooks/lib/pre-push-flags.mjs)
EXIT 1. First 40 lines of the failure (decompile-cli:test), then the failed-task summary.

```
   × file inference name: map.fromContent -> sourcemap from content 0ms
   × file inference name: sourcemap.json -> sourcemap from file name 0ms
   × file inference name: empty.json -> json from file name 0ms

⎯⎯⎯⎯⎯⎯ Failed Tests 13 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/unit/lib/validators/local/index.spec.ts > file inference name: index.css -> css from file name
Error: ENOENT: no such file or directory, stat '/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/decompile-cli/src/tests/fixtures/index.css'
 ❯ Object.statSync ../../node_modules/graceful-fs/polyfills.js:319:16
 ❯ checkIsFileSync src/lib/validators/local/index.ts:20:19
     18|
     19| const checkIsFileSync = (f: string) => {
     20|   const stat = fs.statSync(f);
       |                   ^
     21|   if (!stat.isFile()) {
     22|     return stat.size > 0 ? 1 : 0;
 ❯ Object.getFileInfo src/lib/validators/local/index.ts:53:14
 ❯ test/unit/lib/validators/local/index.spec.ts:39:29

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/13]⎯

 FAIL  test/unit/lib/validators/local/index.spec.ts > file inference name: index.html -> html from file name
Error: ENOENT: no such file or directory, stat '/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/decompile-cli/src/tests/fixtures/index.html'
 ❯ Object.statSync ../../node_modules/graceful-fs/polyfills.js:319:16
 ❯ checkIsFileSync src/lib/validators/local/index.ts:20:19
     18|
     19| const checkIsFileSync = (f: string) => {
     20|   const stat = fs.statSync(f);
       |                   ^
     21|   if (!stat.isFile()) {
     22|     return stat.size > 0 ? 1 : 0;
 ❯ Object.getFileInfo src/lib/validators/local/index.ts:53:14
 ❯ test/unit/lib/validators/local/index.spec.ts:39:29

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/13]⎯

 FAIL  test/unit/lib/validators/local/index.spec.ts > file inference name: index.js -> javascript from file name
Error: ENOENT: no such file or directory, stat '/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/decompile-cli/src/tests/fixtures/index.js'
 ❯ Object.statSync ../../node_modules/graceful-fs/polyfills.js:319:16
 ❯ checkIsFileSync src/lib/validators/local/index.ts:20:19
```

Failed-task summary from the same run:

```
 NX   Running target test for 74 projects and 367 tasks they depend on failed

Failed tasks:

- decompile-cli:test

Output of 440 successful tasks were not shown. Run with --verbose or --output-style=static to see it.


 NX   Nx detected 2 flaky tasks

  backlog:test
  policy:test
```
