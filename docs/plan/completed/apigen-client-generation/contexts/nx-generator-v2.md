# nx-generator-v2 — STATE_NAME

**Phase:** v2-scaffold · **Kind:** work · **Depends on:** plugin-interface, layer-harness · **Guard:** `npx --yes nx test apigen-nx`

---

## Goal

The `@adhd/apigen-nx:plugin` generator emits a **v2-shape** plugin: every generated plugin
implements the v2 plugin interface from `@adhd/apigen-core` (capabilities `{target,layer,mount,envelope}`,
`Call`/`Next`/`Chunk`/`Harness`), is Layer-aware, and conforms to the canonical plugin file layout —
so all apigen plugins (existing + future) share ONE shape produced by the generator. After this state,
`nx g @adhd/apigen-nx:plugin <name>` scaffolds a plugin that builds clean and passes a v2-shape test.

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
mutates:    ["packages/apigen/nx/src/generators/plugin/generator.ts", "packages/apigen/nx/src/generators/plugin/__files__/src/lib/plugin.ts__tmpl__", "packages/apigen/nx/src/generators/plugin/__files__/src/index.ts__tmpl__", "packages/apigen/nx/src/generators/plugin/__files__/src/test/plugin.spec.ts__tmpl__", "packages/apigen/nx/src/generators/plugin/schema.json"]
```

---

## Notes for executor

USER-DIRECTED amendment (close F38 + dogfood the generator). Upgrade the v1 plugin generator to v2:
- Rewrite `__files__/src/lib/plugin.ts__tmpl__` so the generated plugin **implements the v2 plugin
  interface** from `@adhd/apigen-core` (the §7 capabilities `{target,layer,mount,envelope}` + Call/Next/
  Chunk/Harness types) — NOT the v1 `OutputPlugin`. Make it Layer-aware (a plugin may contribute a Layer).
- Update `__files__/src/index.ts__tmpl__` and `__files__/src/test/plugin.spec.ts__tmpl__` to match
  (the test template must assert the generated plugin declares valid v2 capabilities).
- `generator.ts`: keep the default home `packages/apigen/plugins/<name>` and project name
  `apigen-plugin-<name>` (these already match the fill-states logger-layer-plugin/mount-plugins).
  Add a `--platform` option (default `node`; logger/openapi/health are `node`) if helpful. Keep
  `addProjectConfiguration` + `tsconfig.base.json` path update behavior.
- Keep the existing v1 generator/executor tests green; add v2-shape assertions.
Guard: `npx --yes nx test apigen-nx` must pass (incl. a test that generates a probe plugin and checks it
implements the v2 interface). Do NOT leave any probe-generated project behind (clean up in the test).
