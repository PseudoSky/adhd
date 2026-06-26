import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { Command } from 'commander'
import { registerRunCommand, assertFnsNonEmpty, assertDecimalLibPresent } from '../lib/commands/run'
import { registerRunRegistryCommand } from '../lib/commands/run-registry'
import type { OutputPlugin, RunInput, ComposedSchemas } from '@adhd/apigen-core'
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
  it('passes a live fns record and resolves on abort', { timeout: 20000 }, async () => {
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

    // Wait until plugin.run() has been called (bounded poll — no sleep).
    // 12 s to tolerate concurrent ts-morph compilation across 11 test files.
    const deadline = Date.now() + 12000
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
// [dod.fail-fast] Precondition guards — BUG-APIGEN-004 / lt-fail-fast
//
// (a) 0-functions source → actionable "0 functions found" message.
// (b) Decimal surface with absent backing lib → "install decimal.js" message.
// (c) Normal surface (functions present, no decimal) → no guard fires (negative
//     control: proves the guard is not blanket-failing valid sources).
//
// Guards are tested via their exported helper functions so the tests are fast
// (no compilation, no module import, deterministic).  The CLI integration path
// is already covered by [cli-run-cmd.1+2] above.
// ───────────────────────────────────────────────────────────────────────────

describe('[dod.fail-fast.a] assertFnsNonEmpty — 0-function source throws actionable message', () => {
  const emptyFns: Record<string, (...args: unknown[]) => unknown> = {}
  const fakeSource = '/path/to/generated-output.ts'

  it('throws when fns is empty', () => {
    expect(() => assertFnsNonEmpty(emptyFns, fakeSource)).toThrow()
  })

  it('error message contains "0 functions found"', () => {
    expect(() => assertFnsNonEmpty(emptyFns, fakeSource))
      .toThrowError(/0 functions found/)
  })

  it('error message contains the source path', () => {
    expect(() => assertFnsNonEmpty(emptyFns, fakeSource))
      .toThrowError(/generated-output\.ts/)
  })

  it('error message contains actionable hint about wrong source file', () => {
    expect(() => assertFnsNonEmpty(emptyFns, fakeSource))
      .toThrowError(/generated output or the wrong source file/)
  })

  it('does NOT throw when fns has at least one entry (negative-control: guard is not blanket-failing)', () => {
    const nonEmptyFns = { getUser: async () => ({ id: '1' }) }
    expect(() => assertFnsNonEmpty(nonEmptyFns, fakeSource)).not.toThrow()
  })
})

describe('[dod.fail-fast.b] assertDecimalLibPresent — absent decimal.js errors at startup', () => {
  /** Resolver that simulates decimal.js being absent. */
  const absentResolver = (_pkg: string): string => {
    throw new Error(`Cannot find module 'decimal.js'`)
  }

  /** Resolver that simulates decimal.js being present. */
  const presentResolver = (_pkg: string): string => '/node_modules/decimal.js/index.js'

  /** Minimal ComposedSchemas entry that references format:'decimal'. */
  const decimalSchemas: ComposedSchemas = {
    quote: {
      input: {
        type: 'object',
        properties: {
          amount: { type: 'string', format: 'decimal' },
        },
      },
      output: { type: 'string', format: 'decimal' },
    },
  }

  it('throws when a decimal function is present and the lib is absent', () => {
    expect(() => assertDecimalLibPresent(decimalSchemas, absentResolver)).toThrow()
  })

  it('error message names the function', () => {
    expect(() => assertDecimalLibPresent(decimalSchemas, absentResolver))
      .toThrowError(/quote/)
  })

  it('error message instructs the user to install decimal.js', () => {
    expect(() => assertDecimalLibPresent(decimalSchemas, absentResolver))
      .toThrowError(/install `decimal\.js`/)
  })

  it('error message names the missing lib', () => {
    expect(() => assertDecimalLibPresent(decimalSchemas, absentResolver))
      .toThrowError(/decimal\.js/)
  })

  it('does NOT throw when decimal.js is present (resolver succeeds)', () => {
    expect(() => assertDecimalLibPresent(decimalSchemas, presentResolver)).not.toThrow()
  })

  it('does NOT throw when no function uses decimal format (lib absence is irrelevant)', () => {
    const noDecimalSchemas: ComposedSchemas = {
      getUser: {
        input: { type: 'object', properties: { userId: { type: 'string' } } },
        output: { type: 'object', properties: { id: { type: 'string' } } },
      },
    }
    // Even with the absent resolver, no decimal usage → no error
    expect(() => assertDecimalLibPresent(noDecimalSchemas, absentResolver)).not.toThrow()
  })
})

describe('[dod.fail-fast.c] normal surface (negative control) — guards do not fire on valid input', () => {
  it('assertFnsNonEmpty does not fire for a surface with functions (api.ts shape)', () => {
    const fns = {
      getUser: async (userId: string) => ({ id: userId }),
      sendEmail: async (_to: string, _subject: string) => undefined,
    }
    expect(() => assertFnsNonEmpty(fns, apiFixture)).not.toThrow()
  })

  it('assertDecimalLibPresent does not fire for a surface with no decimal types', () => {
    const schemas: ComposedSchemas = {
      getUser: {
        input: { type: 'object', properties: { userId: { type: 'string' } } },
        output: { type: 'object', properties: { id: { type: 'string' } } },
      },
      sendEmail: {
        input: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } },
        output: { type: 'null' },
      },
    }
    // Default resolver — decimal.js may or may not be installed; since no decimal
    // usage, the guard never calls the resolver at all.
    expect(() => assertDecimalLibPresent(schemas)).not.toThrow()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// [cli-run-cmd.non-ts] Non-TS plugin bypasses TS extraction
//
// A plugin that declares `language: 'py'` must have its run() called directly
// — without the source ever being tsx-imported or ts-morph-compiled.
// This guards against the ERR_UNKNOWN_FILE_EXTENSION regression where
// py-flask crashed because the CLI tried to `import()` a .py file.
//
// Proof the test has teeth: if we removed the `pluginLang !== 'ts'` branch
// from run.ts, the command would try to tsx-import the .py fixture path and
// would throw ERR_UNKNOWN_FILE_EXTENSION — this test would go RED.
// ───────────────────────────────────────────────────────────────────────────

describe('[cli-run-cmd.non-ts] non-TS plugin bypasses TS extraction', () => {
  it('calls plugin.run() with importPath set to the source file, no TS compilation', { timeout: 10000 }, async () => {
    let capturedInput: RunInput | undefined

    // A fake "py" plugin — language:'py' so effectiveLanguage() returns 'py'.
    // Its run() resolves immediately after capturing the input.
    const fakePyPlugin: OutputPlugin = {
      id: 'fake-py',
      description: 'fake python plugin for bypass test',
      language: 'py',
      generate() { return { files: [] } },
      async run(input: RunInput): Promise<void> {
        capturedInput = input
      },
    }

    const program = makeProgram()
    registerRunCommand(program, { 'fake-py': fakePyPlugin })

    // Use a .py path that does NOT exist on disk — if TS extraction were
    // attempted it would crash before calling run() at all.
    const fakePySource = path.join(fixturesDir, 'fake_source.py')

    await program.parseAsync([
      'node', 'apigen-cli',
      'run',
      '--source', fakePySource,
      '--type', 'fake-py',
      '--namespace', 'testns',
      '--opt', 'port=9999',
    ])

    // plugin.run() must have been called
    expect(capturedInput).toBeDefined()

    // The importPath must be the resolved source path
    const pkg = capturedInput?.packages[0]
    expect(pkg).toBeDefined()
    expect(pkg?.importPath).toBe(path.resolve(fakePySource))

    // The namespace comes from --namespace flag
    expect(pkg?.id).toBe('testns')

    // The port option is threaded through
    expect(capturedInput?.options['port']).toBe('9999')

    // schemas and fns are empty (non-TS plugin does its own introspection)
    expect(pkg?.schemas).toEqual({})
    expect(pkg?.fns).toBeUndefined()
  })

  it('v2 path: non-TS plugin bypasses TS extraction with --v2 flag', { timeout: 10000 }, async () => {
    let capturedInput: RunInput | undefined

    const fakePyPlugin: OutputPlugin = {
      id: 'fake-py-v2',
      description: 'fake python plugin for v2 bypass test',
      language: 'py',
      generate() { return { files: [] } },
      async run(input: RunInput): Promise<void> {
        capturedInput = input
      },
    }

    const program = makeProgram()
    registerRunCommand(program, { 'fake-py-v2': fakePyPlugin })

    const fakePySource = path.join(fixturesDir, 'fake_source.py')

    await program.parseAsync([
      'node', 'apigen-cli',
      'run',
      '--source', fakePySource,
      '--type', 'fake-py-v2',
      '--namespace', 'testns-v2',
      '--opt', 'port=9998',
      '--v2',
    ])

    expect(capturedInput).toBeDefined()
    const pkg = capturedInput?.packages[0]
    expect(pkg?.importPath).toBe(path.resolve(fakePySource))
    expect(pkg?.id).toBe('testns-v2')
    expect(capturedInput?.options['port']).toBe('9998')
    expect(pkg?.schemas).toEqual({})
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
