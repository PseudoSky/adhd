# @adhd/apigen-plugin-openapi

apigen plugin — emits an **OpenAPI** document for a source file's exports, built on
[`@adhd/apigen-codegen-openapi`](../../codegen/openapi).

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
npx @adhd/apigen-cli generate --source ./api.ts --type openapi --out-dir ./out
```

```ts
import { openapiPlugin, type OpenapiOptions } from '@adhd/apigen-plugin-openapi'
```
