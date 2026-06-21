import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ExecutorContext } from '@nx/devkit'

// Mock execFileSync before importing the executor
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import generateExecutor from '../executors/generate/executor'

const mockExecFileSync = vi.mocked(execFileSync)

const baseContext: ExecutorContext = {
  root: '/workspace',
  projectName: 'my-project',
  targetName: 'generate',
  configurationName: undefined,
  isVerbose: false,
  workspace: {
    version: 2,
    projects: {
      'my-project': {
        root: 'apps/my-project',
        targets: {},
      },
    },
  },
  cwd: '/workspace',
  nxJsonConfiguration: {},
  projectGraph: {
    nodes: {},
    dependencies: {},
  },
  projectsConfigurations: {
    version: 2,
    projects: {
      'my-project': {
        root: 'apps/my-project',
        targets: {},
      },
    },
  },
  taskGraph: {
    roots: [],
    tasks: {},
    dependencies: {},
  },
}

describe('generate executor', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls npx with correct core arguments', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''))

    const result = await generateExecutor(
      { source: 'src/api.ts', type: 'mcp', outDir: 'dist/generated' },
      baseContext
    )

    expect(result).toEqual({ success: true })
    expect(mockExecFileSync).toHaveBeenCalledOnce()

    const [cmd, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(cmd).toBe('npx')
    expect(args).toContain('@adhd/apigen-cli')
    expect(args).toContain('generate')
    expect(args).toContain('--source')
    expect(args).toContain('--type')
    expect(args).toContain('mcp')
    expect(args).toContain('--out-dir')
  })

  it('includes --export flag when exportMode is set', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''))

    await generateExecutor(
      { source: 'src/api.ts', type: 'mcp', outDir: 'dist/generated', exportMode: 'default' },
      baseContext
    )

    const [, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(args).toContain('--export')
    expect(args).toContain('default')
  })

  it('includes --opt flags for each option entry', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''))

    await generateExecutor(
      {
        source: 'src/api.ts',
        type: 'mcp',
        outDir: 'dist/generated',
        options: { transport: 'stdio', port: '3000' },
      },
      baseContext
    )

    const [, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    const optIdx = args.indexOf('--opt')
    expect(optIdx).toBeGreaterThan(-1)
    // both key=value pairs should be present
    const opts = args.filter((_, i, a) => a[i - 1] === '--opt')
    expect(opts).toContain('transport=stdio')
    expect(opts).toContain('port=3000')
  })

  it('returns { success: false } when CLI exits non-zero', async () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error('Command failed')
      ;(err as NodeJS.ErrnoException).status = 1
      throw err
    })

    const result = await generateExecutor(
      { source: 'src/api.ts', type: 'mcp', outDir: 'dist/generated' },
      baseContext
    )

    expect(result).toEqual({ success: false })
  })

  it('omits --export when exportMode is not set', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''))

    await generateExecutor(
      { source: 'src/api.ts', type: 'mcp', outDir: 'dist/generated' },
      baseContext
    )

    const [, args] = mockExecFileSync.mock.calls[0] as [string, string[], unknown]
    expect(args).not.toContain('--export')
  })
})
