import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { Command } from 'commander'
import { registerRunCommand } from '../lib/commands/run'
import { registerRunRegistryCommand } from '../lib/commands/run-registry'
import type { OutputPlugin, RunInput } from '@adhd/apigen-core'
import mcpPlugin from '@adhd/apigen-plugin-mcp'

const fixturesDir = path.join(__dirname, 'fixtures')
const registryDir = path.join(fixturesDir, 'registry')
const apiFixture = path.join(fixturesDir, 'api.ts')

function makeProgram(): Command {
  const program = new Command().name('apigen-cli').exitOverride()
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  })
  return program
}

// ───────────────────────────────────────────────────────────────────────────
// [cli-run-cmd.3] Plugin with no run() method throws a helpful error
// ───────────────────────────────────────────────────────────────────────────

describe('[cli-run-cmd.3] run command — plugin without run() throws', () => {
  it('throws "does not support run mode" when plugin has no run()', async () => {
    const generateOnlyPlugin: OutputPlugin = {
      id: 'gen-only',
      description: 'no run method',
      generate() {
        return { files: [] }
      },
    }

    const program = makeProgram()
    registerRunCommand(program, { 'gen-only': generateOnlyPlugin })

    await expect(
      program.parseAsync([
        'node', 'apigen-cli',
        'run',
        '--source', apiFixture,
        '--type', 'gen-only',
      ])
    ).rejects.toThrow(/does not support run mode/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// [cli-run-cmd.1] run imports source module, passes live fns to plugin.run()
// [cli-run-cmd.2] AbortController.abort() causes plugin.run() to resolve
// [cli-run-cmd.5] --output flag does NOT exist on run command
// ───────────────────────────────────────────────────────────────────────────

describe('[cli-run-cmd.1+2] run command — imports fns and calls plugin.run()', () => {
  it('passes a live fns record and resolves on abort', async () => {
    let capturedInput: RunInput | undefined
    let resolveRun: (() => void) | undefined

    const capturingPlugin: OutputPlugin = {
      id: 'capturing',
      description: 'captures RunInput and waits for abort',
      generate() {
        return { files: [] }
      },
      async run(input: RunInput): Promise<void> {
        capturedInput = input
        // Simulate a long-running server: resolve when signal fires or resolveRun called
        return new Promise<void>((resolve) => {
          resolveRun = resolve
          if (input.signal) {
            input.signal.addEventListener('abort', () => resolve())
          }
        })
      },
    }

    const program = makeProgram()
    registerRunCommand(program, { capturing: capturingPlugin })

    // Start the command — it calls plugin.run() which blocks until abort
    const runPromise = program.parseAsync([
      'node', 'apigen-cli',
      'run',
      '--source', apiFixture,
      '--type', 'capturing',
    ])

    // Wait until plugin.run() has been called (bounded poll — no sleep)
    const deadline = Date.now() + 4000
    while (!capturedInput && Date.now() < deadline) {
      await new Promise<void>((r) => setImmediate(r))
    }
    expect(capturedInput).toBeDefined()

    // [cli-run-cmd.1] fns contains live functions from the fixture
    const packages = capturedInput?.packages ?? []
    expect(packages).toHaveLength(1)
    const pkg = packages[0]
    expect(typeof pkg?.fns?.['getUser']).toBe('function')
    expect(typeof pkg?.fns?.['sendEmail']).toBe('function')
    // __samples__ is NOT in fns (non-function export filtered out)
    expect(pkg?.fns?.['__samples__']).toBeUndefined()

    // [cli-run-cmd.2] Resolving the run promise causes parseAsync to settle
    resolveRun?.()
    await expect(runPromise).resolves.not.toThrow()
  })

  it('[cli-run-cmd.5] --output is not a registered option on the run command', () => {
    const plugin: OutputPlugin = {
      id: 'p',
      description: 'd',
      generate() {
        return { files: [] }
      },
      async run(): Promise<void> { /* no-op */ },
    }
    const program = makeProgram()
    registerRunCommand(program, { p: plugin })
    const runCmd = program.commands.find(c => c.name() === 'run')
    expect(runCmd).toBeDefined()
    const optionNames = (runCmd?.options ?? []).map(o => o.long)
    expect(optionNames).not.toContain('--output')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// [cli-run-cmd.4] run-registry passes ALL packages in one call to plugin.run()
// ───────────────────────────────────────────────────────────────────────────

describe('[cli-run-cmd.4] run-registry command — passes multiple packages at once', () => {
  it('discovers pkg-a and pkg-b and passes them as a single packages array', async () => {
    let capturedInput: RunInput | undefined

    const capturingPlugin: OutputPlugin = {
      id: 'capturing',
      description: 'captures RunInput',
      generate() {
        return { files: [] }
      },
      async run(input: RunInput): Promise<void> {
        capturedInput = input
        // Resolve immediately — test verifies captured packages
      },
    }

    const program = makeProgram()
    registerRunRegistryCommand(program, { capturing: capturingPlugin })

    await program.parseAsync([
      'node', 'apigen-cli',
      'run-registry',
      '--packages-dir', registryDir,
      '--type', 'capturing',
      '--tag', 'api',
    ])

    expect(capturedInput).toBeDefined()
    // plugin.run() was called ONCE with both packages (not once per package)
    const packages = capturedInput?.packages ?? []
    expect(packages).toHaveLength(2)
    const ids = packages.map(p => p.id)
    expect(ids).toContain('pkg-a')
    expect(ids).toContain('pkg-b')

    // Each package carries live fns
    for (const pkg of packages) {
      expect(pkg.fns).toBeDefined()
      // All fns values are functions
      for (const [key, fn] of Object.entries(pkg.fns ?? {})) {
        expect(typeof fn).toBe('function', `expected fns.${key} to be a function`)
      }
      // __samples__ is excluded (it's not a function)
      expect(pkg.fns?.['__samples__']).toBeUndefined()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Live MCP server: run command starts a real streaming-http server
// Gated behind APIGEN_LIVE=1 — skipped in default CI/audit runs.
// ───────────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env['APIGEN_LIVE'])('[cli-run-cmd.1 live] run command starts a live MCP server via plugin.run()', () => {
  const port = 47431 // deterministic high port, different from plugin-mcp tests

  it('serves tools/list with fixture tools over streaming-http', { timeout: 20000 }, async () => {
    const program = makeProgram()
    registerRunCommand(program, { mcp: mcpPlugin })

    // Fire-and-forget: the command keeps the server alive until SIGINT
    const commandPromise = program.parseAsync([
      'node', 'apigen-cli',
      'run',
      '--source', apiFixture,
      '--type', 'mcp',
      '--opt', `transport=streaming-http`,
      '--opt', `port=${port}`,
    ])

    // Poll until server is ready — bounded to 5 s
    const deadline = Date.now() + 5000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
        })
        if (r.ok) { ready = true; break }
      } catch {
        await new Promise<void>((r) => setTimeout(r, 50))
      }
    }
    expect(ready).toBe(true)

    // Verify tools/list includes fixture exports (minus __samples__)
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const text = await res.text()
    // SSE format: `event: message\ndata: <json>\n\n`
    const dataLines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6).trim())
    const parsed = JSON.parse(dataLines[dataLines.length - 1]) as {
      result?: { tools?: Array<{ name: string }> }
      tools?: Array<{ name: string }>
    }
    const tools = parsed?.result?.tools ?? parsed?.tools ?? []
    const names = tools.map((t: { name: string }) => t.name)

    expect(names).toContain('getUser')
    expect(names).toContain('sendEmail')
    expect(names).not.toContain('__samples__')

    // Shut down by emitting SIGINT — triggers the process.on('SIGINT') handler
    // registered in registerRunCommand which calls controller.abort()
    // process.emit('SIGINT') fires event listeners but does NOT kill the test runner.
    process.emit('SIGINT')

    // commandPromise resolves after abort; bounded to 2 s
    await Promise.race([
      commandPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server did not shut down within 2 s')), 2000)
      ),
    ])
  })
})
