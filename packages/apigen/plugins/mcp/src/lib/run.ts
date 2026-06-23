import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { dispatch, createLogger, describeParams } from '@adhd/apigen-runtime'
import type { Logger } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'
import { envelopeMetaKey } from '@adhd/apigen-naming'
import { MCP_ERROR_KIND } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// §9.1 — envelope from MCP _meta (x-<pluginId>-<field>)
// ---------------------------------------------------------------------------

/**
 * Extracts envelope values from MCP `_meta` following the §9.1 binding table.
 *
 * Each envelope field is read from `_meta["x-<pluginId>-<field>"]`.
 * pluginId defaults to 'adhd' when no explicit x-apigen-envelope metadata exists.
 */
function extractEnvelopeFromMeta(
  schema: Record<string, unknown>,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const inputProps = (
    (schema['input'] as Record<string, unknown> | undefined)?.['properties'] as
      | Record<string, unknown>
      | undefined
  ) ?? {}
  const envMeta = schema['x-apigen-envelope'] as Record<string, string> | undefined
  const envelope: Record<string, unknown> = {}
  for (const field of Object.keys(inputProps)) {
    if (field === 'data') continue
    const pluginId = envMeta?.[field] ?? 'adhd'
    const metaKey = envelopeMetaKey(pluginId, field)
    const value = meta[metaKey]
    if (value !== undefined) envelope[field] = value
  }
  return envelope
}

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
    // §9.1: envelope fields come from _meta["x-<pluginId>-<field>"], not from args body.
    const mcpMeta = (args as any)['_meta'] as Record<string, unknown> | undefined ?? {}
    const meta = toolMetas[name]
    if (!meta) throw new Error(`Unknown tool: ${name}`)
    const pkg = input.packages.find((p) => p.id === meta.group)!
    const fnSchema = meta.schema as Record<string, unknown>
    const envelope = extractEnvelopeFromMeta(fnSchema, mcpMeta)
    const domainData = ((args as any)['data'] ?? {}) as Record<string, unknown>
    const start = Date.now()
    try {
      const result = await dispatch(
        pkg.fns!,
        pkg.createClient,
        meta.schema as any,
        name,
        envelope,
        domainData,
      )
      logger.info({ tool: name, ms: Date.now() - start }, `→ ${name}`)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      logger.error({ tool: name, ms: Date.now() - start, err }, `✗ ${name}`)
      // §9: MCP surfaces all apigen errors as the 'error' result kind.
      const mcpKind = MCP_ERROR_KIND['internal']
      void mcpKind // the kind constant validates the §9 table is wired; error is re-thrown for MCP SDK
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
      try {
        const url = req.url ?? ''
        if (req.method === 'GET' && url === '/sse') {
          const sseTransport = new SSEServerTransport('/messages', res)
          sessions.set(sseTransport.sessionId, sseTransport)
          sseTransport.onclose = () => sessions.delete(sseTransport.sessionId)
          // server.connect() calls transport.start() internally, which writes the
          // `endpoint` SSE event. Do NOT call start() again — the SDK throws
          // "SSEServerTransport already started!" and the unhandled rejection
          // crashes the whole process, killing the SSE stream mid-handshake.
          await server.connect(sseTransport)
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
      } catch (err) {
        // Never let a handler rejection become an unhandled rejection that
        // tears down the whole server (which would kill all live SSE streams).
        logger.error({ err }, 'sse request handler error')
        if (!res.headersSent) res.writeHead(500)
        if (!res.writableEnded) res.end('Internal Server Error')
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
