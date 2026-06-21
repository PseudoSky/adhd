import express, { Router } from 'express'
import { dispatch } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'
import type { Server } from 'node:http'

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const routePrefix = (input.options['routePrefix'] as string) ?? ''

  const app = express()
  app.use(express.json())
  const router = Router()

  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
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
    const s = app.listen(port, () => resolve(s))
  })

  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        server.close(() => resolve())
      })
    }
  })
}
