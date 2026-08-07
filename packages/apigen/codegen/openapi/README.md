# @adhd/apigen-codegen-openapi

OpenAPI 3.x document generation for apigen — turns an apigen descriptor into an OpenAPI
document. Pure TypeScript (**platform: shared**).

Part of [apigen](../../README.md).

## Public API

```ts
import { toOpenApi } from '@adhd/apigen-codegen-openapi'
import type { OpenApiDocument, ToOpenApiOptions } from '@adhd/apigen-codegen-openapi'

const doc = toOpenApi(descriptor, options)
```

- **`toOpenApi(descriptor, opts)`** — descriptor → `OpenApiDocument`.
