# @adhd/apigen-plugin-logger

apigen **Layer plugin** — wraps dispatch with structured request/timing logging. Activate with
`--use` on any target.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
npx @adhd/apigen-cli run --source ./api.ts --type mcp --use @adhd/apigen-plugin-logger
```

```ts
import { loggerPlugin, makeLoggerPlugin, type LoggerOptions } from '@adhd/apigen-plugin-logger'
```
