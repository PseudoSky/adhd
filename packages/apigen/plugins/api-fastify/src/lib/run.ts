import Fastify from 'fastify'
import { dispatch } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const routePrefix = (input.options['routePrefix'] as string) ?? ''
  const app = Fastify()

  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      // We deliberately omit `schema: { body: fnSchema.input }` — generated
      // schemas use oneOf/anyOf shapes that Fastify's AJV rejects at route
      // registration time. Validation is deferred to dispatch(). [plugin-api-fastify.4]
      app.post(route, async (req) => {
        const { data = {}, ...envelope } = req.body as Record<string, unknown>
        return dispatch(
          pkg.fns!,
          pkg.createClient,
          fnSchema,
          fnName,
          envelope,
          data as Record<string, unknown>,
        )
      })
    }
  }

  await app.listen({ port })
  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', async () => {
        await app.close()
        resolve()
      })
    }
  })
}
