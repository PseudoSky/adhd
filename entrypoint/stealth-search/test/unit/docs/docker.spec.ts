/**
 * guards: the Dockerfile drifts from the package (bin names, Chrome resolution) or the docs stop pointing at it
 * tier: S
 * Reads package files only: no docker, no process, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string> }
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const guide = readFileSync(join(root, 'docs', 'DOCKER.md'), 'utf8')

describe('docker image', () => {
  it('installs this package and starts a bin it declares', () => {
    expect(dockerfile).toContain(`${pkg.name}@`)
    expect(Object.keys(pkg.bin)).toContain('stealth-search-mcp')
    expect(dockerfile).toMatch(/CMD \["stealth-search-mcp"/)
  })

  it('puts a google-chrome on PATH, because the launcher resolves that name on linux', () => {
    expect(dockerfile).toContain('/usr/local/bin/google-chrome')
  })

  it('runs unprivileged on a virtual display', () => {
    expect(dockerfile).toMatch(/^USER node$/m)
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "xvfb-run", "-a"]')
  })

  it('is linked from the README and documented', () => {
    expect(readme).toContain('docs/DOCKER.md')
    expect(guide).toContain('docker build')
  })
})
