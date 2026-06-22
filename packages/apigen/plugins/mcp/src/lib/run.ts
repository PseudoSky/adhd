import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { dispatch, createLogger, describeParams } from '@adhd/apigen-runtime'
import type { Logger } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'

function buildMcpServer(input: RunInput, logger: Logger): {
  server: InstanceType<typeof Server>
  toolMetas: Record<string, { group: string; schema: unknown }>
} {
  const descriptions =
    (input.options['toolDescriptions'] as Record<string, string>) ?? {}

  const server = new Server(
    { name: 'apigen-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // Build toolMetas from all packages
  const toolMetas: Record<string, { group: string; schema: unknown }> = {}
  for (const pkg of input.packages) {
    for (const fnName of Object.keys(pkg.schemas)) {
      toolMetas[fnName] = { group: pkg.id, schema: pkg.schemas[fnName] }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(toolMetas).map(([name, meta]) => ({
      name,
      description: descriptions[name] ?? name,
      inputSchema: (meta.schema as any).input,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    const meta = toolMetas[name]
    if (!meta) throw new Error(`Unknown tool: ${name}`)
    const pkg = input.packages.find((p) => p.id === meta.group)!
    const start = Date.now()
    try {
      const result = await dispatch(
        pkg.fns!,
        pkg.createClient,
        meta.schema as any,
        name,
        args as Record<string, unknown>,
        ((args as any)['data'] ?? {}) as Record<string, unknown>,
      )
      logger.info({ tool: name, ms: Date.now() - start }, `→ ${name}`)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      logger.error({ tool: name, ms: Date.now() - start, err }, `✗ ${name}`)
      throw err
    }
  })

  return { server, toolMetas }
}

export async function run(input: RunInput): Promise<void> {
  const transport = (input.options['transport'] as string) ?? 'stdio'
  const port = (input.options['port'] as number) ?? 3000
  const host = (input.options['host'] as string) ?? '127.0.0.1'
  // Fall back to a default stderr logger so logging never lands on stdout (the
  // stdio JSON-RPC channel) even when the CLI did not supply one.
  const logger = input.logger ?? createLogger()

  logger.info(`mcp server starting (${transport})`)

  const { server, toolMetas } = buildMcpServer(input, logger)
  const toolNames = Object.keys(toolMetas)
  logger.info({ tools: toolNames }, `${toolNames.length} tools available`)
  for (const [name, meta] of Object.entries(toolMetas)) {
    const { params, text } = describeParams(meta.schema as { input?: unknown })
    logger.info(
      { tool: name, args: { data: params } },
      `tool: ${name}  args { data: {${text ? ` ${text} ` : ''}} }`,
    )
  }

  if (transport === 'stdio') {
    const t = new StdioServerTransport()
    await server.connect(t)
    logger.info('stdio transport ready')
    return new Promise<void>((resolve) => {
      if (input.signal) input.signal.addEventListener('abort', () => {
        logger.info('mcp server shutting down')
        resolve()
      })
    })
  }

  if (transport === 'sse') {
    // SSEServerTransport is per-connection: instantiate per GET request, route POSTs by sessionId
    const sessions = new Map<string, SSEServerTransport>()

    const httpServer = createServer(async (req, res) => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url === '/sse') {
        const sseTransport = new SSEServerTransport('/messages', res)
        sessions.set(sseTransport.sessionId, sseTransport)
        sseTransport.onclose = () => sessions.delete(sseTransport.sessionId)
        await server.connect(sseTransport)
        await sseTransport.start()
      } else if (req.method === 'POST' && url.startsWith('/messages')) {
        const sessionId = new URLSearchParams(url.split('?')[1] ?? '').get(
          'sessionId',
        )
        const sseTransport = sessionId ? sessions.get(sessionId) : undefined
        if (!sseTransport) {
          res.writeHead(404)
          res.end('Session not found')
          return
        }
        await sseTransport.handlePostMessage(req, res)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    httpServer.listen(port, host, () => {
      logger.info({ host, port }, `listening on http://${host}:${port}`)
    })
    return new Promise<void>((resolve) => {
      if (input.signal) {
        input.signal.addEventListener('abort', () => {
          logger.info('mcp server shutting down')
          httpServer.close(() => resolve())
        })
      }
    })
  }

  // streaming-http transport — stateless mode.
  // The StreamableHTTPServerTransport is single-use per connection in stateless mode:
  // each request needs its own transport instance connected to a fresh Server.
  // We rebuild the server + transport per request so the MCP state is clean.
  const httpServer = createServer(async (req, res) => {
    const { server: reqServer } = buildMcpServer(input, logger)
    const mcpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await reqServer.connect(mcpTransport)
    await mcpTransport.handleRequest(req, res)
  })
  httpServer.listen(port, host, () => {
    logger.info({ host, port }, `listening on http://${host}:${port}`)
  })
  return new Promise<void>((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        logger.info('mcp server shutting down')
        httpServer.close(() => resolve())
      })
    }
  })
}
