import express, { Router } from 'express'
import { pinoHttp } from 'pino-http'
import { dispatch, createLogger } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'
import type { Server } from 'node:http'

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const host = (input.options['host'] as string) ?? '127.0.0.1'
  const routePrefix = (input.options['routePrefix'] as string) ?? ''
  // Fall back to a default stderr logger when the CLI did not supply one.
  const logger = input.logger ?? createLogger()

  const app = express()
  // pino-http logs every request via the shared logger instance.
  app.use(pinoHttp({ logger }))
  app.use(express.json())
  const router = Router()

  const routes: string[] = []
  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      routes.push(route)
      router.post(route, async (req, res) => {
        const { data = {}, ...envelope } = req.body as Record<string, unknown>
        const result = await dispatch(
          pkg.fns!,
          pkg.createClient,
          fnSchema,
          fnName,
          envelope,
          data as Record<string, unknown>,
        )
        res.json(result)
      })
    }
  }

  app.use(router)

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s))
  })
  logger.info({ host, port }, `listening on http://${host}:${port}`)
  for (const route of routes) logger.info(`POST ${route}`)

  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        server.close(() => resolve())
      })
    }
  })
}
