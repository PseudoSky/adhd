# Tier D — auto-screened (build-config-only, no runtime surface)

These packages matched the inventory ONLY via a build config (`vite.config.ts` / `vitest.config.ts` / `.babelrc`) and have **zero** runtime env/fs/log/db surface. They are not @adhd/environment adoption candidates.

| package | root | matched file(s) |
|---|---|---|
| `@adhd/agent-base-types` | adhd | vite.config.ts |
| `@adhd/apigen-base-errors` | adhd | vite.config.ts |
| `@adhd/apigen-base-logical` | adhd | vite.config.ts |
| `@adhd/apigen-base-schema` | adhd | vite.config.ts |
| `@adhd/apigen-base-types` | adhd | vite.config.ts |
| `@adhd/apigen-codegen-openapi` | adhd | vite.config.ts |
| `@adhd/apigen-engine-gateway` | adhd | vite.config.ts |
| `@adhd/apigen-engine-naming` | adhd | vite.config.ts |
| `@adhd/apigen-generator-nx` | adhd | vite.config.ts |
| `@adhd/apigen-plugin-health` | adhd | vite.config.ts |
| `@adhd/apigen-plugin-jsonschema` | adhd | vite.config.ts |
| `@adhd/apigen-plugin-openapi` | adhd | vite.config.ts |
| `@adhd/data-base-transforms` | adhd | vite.config.ts |
| `@adhd/data-core-structures` | adhd | vite.config.ts |
| `@adhd/data-query-engine` | adhd | vite.config.ts |
| `@adhd/dispatch-base-types` | adhd | vite.config.ts |
| `@adhd/ui-react-base-hooks` | adhd | .babelrc, vite.config.ts |
| `@adhd/sox-claim-verification` | sox-ecosystem | vitest.config.ts |
| `@adhd/sox-manifest` | sox-ecosystem | vitest.config.ts |
