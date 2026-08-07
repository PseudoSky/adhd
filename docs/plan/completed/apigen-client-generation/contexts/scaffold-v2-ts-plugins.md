# scaffold-v2-ts-plugins — STATE_NAME

**Phase:** v2-scaffold · **Kind:** work · **Depends on:** scaffold-plugins, nx-generator-v2 · **Guard:** `npx --yes nx run-many -t build -p apigen-plugin-logger apigen-plugin-openapi apigen-plugin-health`

---

## Goal

The 3 v2 mount/Layer plugins (logger, openapi, health) exist as buildable nx projects
`apigen-plugin-{logger,openapi,health}` at `packages/apigen/plugins/<name>`, **scaffolded via the
upgraded `@adhd/apigen-nx:plugin` generator** so they share the canonical v2 plugin shape. (Slug retains
the legacy "ts-plugins" name; the real home is `packages/apigen/plugins/`, NOT `ts/plugins/` — F38 closed.)

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
mutates:    ["packages/apigen/plugins/logger/project.json", "packages/apigen/plugins/openapi/project.json", "packages/apigen/plugins/health/project.json"]
```

---

## Notes for executor

DOGFOOD the generator — do NOT hand-roll these. For each of logger, openapi, health run:
`npx --yes nx g @adhd/apigen-nx:plugin <name>` (creates `packages/apigen/plugins/<name>`, project
`apigen-plugin-<name>`, and updates `tsconfig.base.json` automatically). The plugins.ts is a v2-shape
stub; the FILL states (`logger-layer-plugin`, `mount-plugins`) overwrite `src/lib/plugin.ts` with real
impl later — leave the generated stub buildable.
DEPRECATION HYGIENE: ensure NO `packages/apigen/ts/` dir and NO `apigen-ts-plugin-*` project are ever
created (that abandoned path is fully removed/never materialized). Guard:
`npx --yes nx run-many -t build -p apigen-plugin-logger apigen-plugin-openapi apigen-plugin-health` → green.
