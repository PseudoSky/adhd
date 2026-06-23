# @adhd/apigen-plugin-health

apigen **mount plugin** — adds a health endpoint to a generated server. Activate with `--use`.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
npx @adhd/apigen-cli run --source ./api.ts --type api-fastify --use @adhd/apigen-plugin-health
```

```ts
import { healthPlugin, type HealthOptions } from '@adhd/apigen-plugin-health'
```
