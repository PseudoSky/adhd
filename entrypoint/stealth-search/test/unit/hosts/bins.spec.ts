/**
 * guards: a bin loads the host graph before the Node preflight, reaches telemetry outside './telemetry.js', or a host file reads the environment
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [search-hosts.9] [search-hosts.11] [search-hosts.15] [search-hosts.16] [search-hosts.19]
 * The two bins: the Node >= 22.5 preflight runs before the host graph is loaded, telemetry is
 * reached only through './telemetry.js', and no host file reads the environment. Ticket 8468f7b1 ·
 * plan state search-hosts.
 *
 * Criteria: [search-hosts.9] [search-hosts.11] [search-hosts.15] [search-hosts.16] [search-hosts.19]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const codeOf = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const realVersions = process.versions
const realExitCode = process.exitCode

afterEach(() => {
  Object.defineProperty(process, 'versions', { value: realVersions, configurable: true })
  process.exitCode = realExitCode
  vi.restoreAllMocks()
  vi.resetModules()
})

for (const bin of ['bin/cli.ts', 'bin/mcp.ts']) {
  describe(`${bin}: the preflight [search-hosts.9]`, () => {
    it('NODE_TOO_OLD: on Node 20 the bin writes ONE `NODE_TOO_OLD:` line, sets exit status 12 and loads nothing else', async () => {
      Object.defineProperty(process, 'versions', { value: { ...realVersions, node: '20.19.0' }, configurable: true })
      const written: string[] = []
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write)
      await import(/* @vite-ignore */ join(root, bin))
      expect(written).toHaveLength(1)
      expect(written[0]).toMatch(/^NODE_TOO_OLD: Node\.js 20\.19\.0 is too old; stealth-search needs Node\.js 22\.5 or newer\n$/)
      expect(process.exitCode).toBe(12)
    })

    it('[audit-fixes.1] P31 the bin never discards the host promise: it applies the status and handles a rejection', () => {
      const code = codeOf(read(bin))
      expect(code).toMatch(/(?:runCli|mcpMain)\([\s\S]*?\)\.then\(/)
      if (bin === 'bin/cli.ts') expect(code).toMatch(/process\.exitCode = code/)
    })

    it('the comparison against 22.5 comes before any require of the host graph, and telemetry is reached through ./telemetry.js only', () => {
      const text = read(bin)
      const code = codeOf(text)
      expect(code).toContain('process.versions.node')
      expect(code).toMatch(/nodeMajor === 22 && nodeMinor < 5/)
      expect(code).toContain('NODE_TOO_OLD')
      expect(code.indexOf('NODE_TOO_OLD')).toBeLessThan(code.indexOf('require('))
      expect(code).toContain("require('../src/telemetry.js')")
      expect(code).not.toMatch(/^import\s/m)
      expect(code).not.toMatch(/initTelemetry\(|serviceName|@adhd\/apigen-plugin-tracing/)
    })
  })
}

describe('host source hygiene [search-hosts.11] [search-hosts.15]', () => {
  const files = ['src/server.ts', 'src/cli.ts', 'src/host-flags.ts', 'src/host-errors.ts', 'bin/cli.ts', 'bin/mcp.ts']

  it('no host file reads an environment variable or imports tsx', () => {
    for (const f of files) {
      const code = codeOf(read(f))
      expect(code, f).not.toMatch(/process\.env/)
      expect(code, f).not.toMatch(/from\s+['"]tsx|require\(['"]tsx/)
    }
  })

  it('no host file throws a bare Error or a string', () => {
    for (const f of files) expect(codeOf(read(f)), f).not.toMatch(/\bnew\s+(?:Error|TypeError|RangeError)\s*\(|\bthrow\s+['"`]|Promise\.reject\(\s*['"`]/)
  })

  it('server.ts and cli.ts mount the tracing plugin of ./tracing.js in usePlugins and hold no serviceName or initTelemetry call', () => {
    for (const f of ['src/server.ts', 'src/cli.ts']) {
      const text = read(f)
      expect(text, f).toMatch(/import\s*\{[^}]*tracingPlugin[^}]*\}\s*from\s*'\.\/tracing\.js'/)
      expect(text, f).toMatch(/usePlugins\s*:\s*\[[^\]]*tracingPlugin/)
      expect(codeOf(text), f).not.toMatch(/serviceName|initTelemetry\(|@adhd\/apigen-plugin-tracing/)
    }
  })

  it('9d05e8b2 tripwireStatus: neither host holds an expiry or TTL predicate of its own (the one verb decides what expired)', () => {
    for (const f of ['src/server.ts', 'src/cli.ts']) expect(codeOf(read(f)), f).not.toMatch(/expiresAt|\bttl\b|Date\.now\(\)/i)
  })

  it('657bd597 isTTY: the CLI prompter checks stdin.isTTY and the stream end', () => {
    const code = codeOf(read('src/cli.ts'))
    expect(code).toMatch(/isTTY/)
    expect(code).toMatch(/readableEnded/)
  })
})
