# scaffold-packages — SCAFFOLD 4 CORE APIGEN PACKAGES

**Phase:** scaffolding · **Depends on:** (none) · **Guard:** `node -e "const fs=require('fs'); ['packages/apigen/core','packages/apigen/runtime','packages/apigen/nx','packages/apigen/cli'].forEach(d=>{if(!fs.existsSync(d+'/project.json'))throw new Error('missing: '+d)})"`

---

## Goal

Create the directory and project scaffolding for the **4 non-plugin** `@adhd/apigen-*` packages: `core`, `runtime`, `nx`, and `cli`. After this state every package has a valid Nx project (`project.json`), a `package.json`, a `vite.config.ts`, tsconfig files, and an empty `src/index.ts`.

**The 5 plugin packages are NOT created here.** They are scaffolded in `scaffold-plugins` using the generator built in `nx-generator`. This state exists only to get the foundational 4 packages into the Nx project graph so that `core-types` and `nx-generator` can build.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/*/project.json` × 4.
- **Reference Pattern:** Look at `packages/ai/agent-mcp/project.json` for the established pattern (tags, nx-release-publish dependsOn, vite emptyOutDir). Mirror it.
- **Delta Spec:**

Run these commands from the monorepo root (NOT using generate-lib.sh — it doesn't support the `apigen` directory):

```bash
# Core — platform:shared (pure TS, safe in browser or node)
npx --yes nx g @nx/js:library apigen-core \
  --directory packages/apigen/core \
  --tags "layer:logic,platform:shared" \
  --importPath "@adhd/apigen-core" \
  --publishable --bundler vite --no-interactive

# Runtime — platform:shared (pure TS, no Node-only APIs)
npx --yes nx g @nx/js:library apigen-runtime \
  --directory packages/apigen/runtime \
  --tags "layer:logic,platform:shared" \
  --importPath "@adhd/apigen-runtime" \
  --publishable --bundler vite --no-interactive

# Nx generator/executor package — platform:node
npx --yes nx g @nx/js:library apigen-nx \
  --directory packages/apigen/nx \
  --tags "layer:logic,platform:node" \
  --importPath "@adhd/apigen-nx" \
  --publishable --bundler vite --no-interactive

# CLI entrypoint — platform:node
npx --yes nx g @nx/js:library apigen-cli \
  --directory packages/apigen/cli \
  --tags "layer:entrypoints,platform:node" \
  --importPath "@adhd/apigen-cli" \
  --publishable --bundler vite --no-interactive
```

After each generation, apply the **two standard patches**:

**Patch 1 — vite.config.ts: add `emptyOutDir: true`** (prevents stale dist/package.json on rebuild):
```python
import re, sys
path = sys.argv[1]
src = open(path).read()
if 'emptyOutDir' not in src:
    src = re.sub(r'([ \t]*outDir:[^\n]+\n)', r'\1    emptyOutDir: true,\n', src)
    open(path, 'w').write(src)
```

**Patch 2 — project.json: add `dependsOn: ["build", "test"]` to nx-release-publish**:
```javascript
const fs = require('fs')
const json = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const pub = json?.targets?.['nx-release-publish']
if (pub && !pub.dependsOn) {
  pub.dependsOn = ['build', 'test']
  fs.writeFileSync(process.argv[2], JSON.stringify(json, null, 2) + '\n')
}
```

**Wire tsconfig.base.json paths** — add the 4 core entries now. The 5 plugin paths will be added automatically by the generator in `scaffold-plugins`:
```json
{
  "@adhd/apigen-core": ["./packages/apigen/core/src/index.ts"],
  "@adhd/apigen-runtime": ["./packages/apigen/runtime/src/index.ts"],
  "@adhd/apigen-nx": ["./packages/apigen/nx/src/index.ts"],
  "@adhd/apigen-cli": ["./packages/apigen/cli/src/index.ts"]
}
```

- **Invariants:** `[inv:nx-platform-tags]` — tags must be exactly as specified above.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/core/project.json",
            "packages/apigen/core/package.json",
            "packages/apigen/core/vite.config.ts",
            "packages/apigen/runtime/project.json",
            "packages/apigen/runtime/package.json",
            "packages/apigen/runtime/vite.config.ts",
            "packages/apigen/nx/project.json",
            "packages/apigen/nx/package.json",
            "packages/apigen/cli/project.json",
            "packages/apigen/cli/package.json",
            "tsconfig.base.json"]
read_only:  ["nx.json",
            "package.json",
            "packages/ai/agent-mcp/project.json"]
```

---

## Acceptance criteria

- `[scaffold-packages.1]` All 4 `project.json` files exist with correct `tags` field:
  ```bash
  for d in packages/apigen/core packages/apigen/runtime packages/apigen/nx packages/apigen/cli; do
    node -e "const j=require('./$d/project.json'); if(!j.tags) throw new Error('no tags in $d')"
  done
  ```

- `[scaffold-packages.2]` All 4 packages appear in Nx project list:
  ```bash
  npx --yes nx show projects | grep -E "^apigen-(core|runtime|nx|cli)$"
  ```
  Expected: 4 matches (no plugin packages yet).

- `[scaffold-packages.3]` tsconfig.base.json has all 4 `@adhd/apigen-*` path entries (plugins come later):
  ```bash
  node -e "const p=require('./tsconfig.base.json').compilerOptions.paths; ['@adhd/apigen-core','@adhd/apigen-runtime','@adhd/apigen-nx','@adhd/apigen-cli'].forEach(k=>{ if(!p[k]) throw new Error('missing path: '+k) })"
  ```

- `[scaffold-packages.4]` vite.config.ts has `emptyOutDir: true` in all 4 packages:
  ```bash
  for d in packages/apigen/core packages/apigen/runtime packages/apigen/nx packages/apigen/cli; do
    grep -q emptyOutDir "$d/vite.config.ts" || (echo "FAIL: $d/vite.config.ts missing emptyOutDir" && exit 1)
  done
  ```

- `[scaffold-packages.5]` `nx-release-publish` target has `dependsOn` in all 4 packages:
  ```bash
  for d in packages/apigen/core packages/apigen/runtime packages/apigen/nx packages/apigen/cli; do
    node -e "const j=require('./$d/project.json'); if(!j.targets?.['nx-release-publish']?.dependsOn) throw new Error('missing dependsOn in $d')"
  done
  ```

---

## Commit points

1. After all 4 nx generate commands and patches: `feat(apigen): scaffold core/runtime/nx/cli apigen packages`

---

## Notes for executor

- Run all Nx generate commands sequentially (they modify the Nx cache; parallel runs may conflict).
- If `nx g` fails with a conflict, stop and escalate — do not force.
- After patching, run `npx --yes nx reset` to clear the Nx project graph cache before testing.
- Do NOT scaffold the plugin packages here. They are created by `scaffold-plugins` using the generator. This keeps plugin structure consistent and proves the generator works on real targets.
