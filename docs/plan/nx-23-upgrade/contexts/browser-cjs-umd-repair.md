# browser-cjs-umd-repair — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** browser-package-build-repair · **Guard:** `./node_modules/.bin/nx build ui-react-base-hooks && ./node_modules/.bin/vitest run --config packages/ui-react/ui-react-base-hooks/vite.config.ts packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts && node -e "const fs=require('fs');for(const f of ['packages/ui-react/ui-react-base-hooks/dist/index.js','packages/ui-react/ui-react-base-hooks/dist/index.umd.js']){const t=fs.readFileSync(f,'utf8');if(t.includes('{}.url')){console.error('EMPTY_IMPORT_META_URL in '+f);process.exit(1)}if(t.includes('__filename')||t.includes('node:url')){console.error('NODE_SHIM_IN_BROWSER_BUNDLE in '+f);process.exit(1)}}console.log('BROWSER_BUNDLES_CLEAN')"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [browser-cjs-umd-repair.1] Both browser CJS and UMD bundles are free of the empty-import-meta token and of the node-only shim

- [browser-cjs-umd-repair.2] The default-running browser acceptance spec exists
- [browser-cjs-umd-repair.3] The spec asserts against the BUILT bundles, not the source, because the defect is created by the bundler
- [browser-cjs-umd-repair.4] The ESM bundle still carries native import.meta.url and is left untouched
- [browser-cjs-umd-repair.5] The decision record states why the node shim is not a valid browser fix
- [browser-cjs-umd-repair.6] Injecting the empty-import-meta token into a built browser bundle makes the bundle assertion fail
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "packages/ui-react/ui-react-base-hooks/package.json", "packages/ui-react/ui-react-base-hooks/project.json", "docs/plan/nx-23-upgrade/BROWSER-BUILD-REPAIR.md"]
mutates:    ["packages/ui-react/ui-react-base-hooks/vite.config.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts", "tools/vite-plugins/import-meta-url-browser-cjs.mjs", "tools/vite-plugins/README.md", "docs/plan/nx-23-upgrade/scripts/neg-control-browser-bundle.mjs", "docs/plan/nx-23-upgrade/BROWSER-BUNDLE-REPAIR.md"]
```

---

## Notes for executor

The node CJS shim is NOT a valid fix here: its require/__filename do not exist in a browser chunk, so wiring it in trades undefined for ReferenceError. The guard therefore also asserts the node shim is ABSENT from the browser bundles. ui-react-base-storybook is private:true and explicitly out of scope.
