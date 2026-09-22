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

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ui-react/ui-react-base-hooks/vite.config.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts", "tools/vite-plugins/import-meta-url-browser-cjs.mjs", "tools/vite-plugins/README.md", "docs/plan/nx-23-upgrade/scripts/neg-control-browser-bundle.mjs", "docs/plan/nx-23-upgrade/BROWSER-BUNDLE-REPAIR.md"]
```

---

## Notes for executor

The node CJS shim is NOT a valid fix here: its require/__filename do not exist in a browser chunk, so wiring it in trades undefined for ReferenceError. The guard therefore also asserts the node shim is ABSENT from the browser bundles. ui-react-base-storybook is private:true and explicitly out of scope.
