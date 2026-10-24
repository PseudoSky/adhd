# Reaper load proof (sp-reaper-load-proof)

Proves the detached reaper can load the BUILT package entry with `require` from an unrelated cwd, and that the exact spawn form works against a stub namespace.

BUILD: nx run stealth-browser:build exit=0
LOAD-CWD: /var/folders/yg/cfczgtx54bzfh74lx2_mv0z80000gp/T/rlp-PlaqKr
LOAD: exit=0 typeof=object

Command (from LOAD-CWD, outside the repository): `node -e "const m=require(process.argv[1]); console.log(typeof m)" /Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/stealth-browser/dist/index.js`. Printed `object`, process exited on its own (no CDP connection, no timer).

EXTERNAL: yes

External evidence: `dist/index.js` contains zero occurrences of `sox-service-proxy` (nothing inlined). Today it also contains no runtime `require` of it, because `src/lib/runtime-deps.ts` only holds a type-only reference (erased at build); the external `require` appears once chrome-lifecycle imports the package. `externalizeRealDeps(entrypoint/stealth-browser)` returns `'@adhd/sox-service-proxy'` and `/^@adhd\/sox-service-proxy\//` (package.json lists it in `dependencies`), so rollup keeps it external. Remaining requires in dist: `@xmldom/xmldom`, `node-html-parser`, `xpath`, node builtins.

Resolution note: externals resolve from the repository root `node_modules` (no package-local node_modules in this pnpm workspace). The scratch copy therefore symlinks that `node_modules`, mirroring an installed package.

SPAWN: exit=0

Spawn form (scratch copy of `dist/` under LOAD-CWD, stub `module.exports.lifecycle = { runChromeReaper }` appended to the scratch file only; `stdio: 'ignore'`, `detached: true`):
`process.execPath ['-e', 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))', <abs scratch dist/index.js>, '{"pid":1,"port":0}']`
Child exited 0 and the stub wrote `reaper-stub {"pid":1,"port":0}`. Package source untouched; Chrome and port 9222 never touched.

VERDICT: entry-path-ok
