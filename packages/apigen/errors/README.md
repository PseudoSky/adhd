# @adhd/apigen-errors

Canonical error model for apigen — one set of error codes mapped to each transport's status
convention (HTTP, gRPC, CLI exit, MCP), plus streaming-error phase helpers. Pure TypeScript
(**platform: shared**).

Part of [apigen](../README.md).

## Public API

```ts
import {
  ERROR_CODES, HTTP_STATUS, GRPC_CODE, CLI_EXIT_CODE, MCP_ERROR_KIND, statusMaps,
  ApiError, toStreamingError, isBeforeFirstChunk, isAfterFirstChunk,
} from '@adhd/apigen-errors'
```

- **`ERROR_CODES` / `ApiErrorCode`** — the canonical code set.
- **`HTTP_STATUS` / `GRPC_CODE` / `CLI_EXIT_CODE` / `MCP_ERROR_KIND` / `statusMaps`** —
  per-transport mappings so every surface reports the same error consistently.
- **`ApiError`** — the error carrier; the **streaming helpers** classify before/after-first-chunk
  errors for correct mid-stream reporting.
