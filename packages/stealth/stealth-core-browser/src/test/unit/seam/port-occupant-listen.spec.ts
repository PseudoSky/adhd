/**
 * The port-occupant lookup signals only the Chrome that OWNS the port, never a connected client:
 * the default process probe lists listeners with `lsof -ti tcp:<port> -sTCP:LISTEN`.
 * Ticket 8468f7b1 · [core-seam.9] · commit 591e1a7 (delta report row 14).
 * node:child_process is mocked through vi.mock (an `execSync` that answers by command string) and process.kill
 * is replaced: nothing is spawned, no real process or port is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error('the unit lane must never spawn')
  }),
}))

vi.mock('node:child_process', () => ({ execSync: m.execSync, spawn: m.spawn }))

import { killChrome, systemProcessProbe } from '../../../lib/cdp/browser.js'

const PORT = 9333
const PROFILE = '/home/operator/Library/Application Support/Google/Chrome-CDP'
const OWNER = 4242
const CLIENT = 5151
const LISTEN_CMD = `lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null`
const OLD_CMD = `lsof -ti tcp:${PORT} 2>/dev/null`
const chromeCmd = `/Applications/Google Chrome --remote-debugging-port=${PORT} --user-data-dir=${PROFILE} --no-first-run`

let signalled: Array<[number, string | number | undefined]>
let commands: string[]

beforeEach(() => {
  signalled = []
  commands = []
  m.execSync.mockReset()
  // The stub answers by command string. The old form reports the owner AND a connected client; the LISTEN form only the owner.
  m.execSync.mockImplementation((cmd: string) => {
    commands.push(cmd)
    if (cmd === OLD_CMD) return `${OWNER}\n${CLIENT}\n`
    if (cmd === LISTEN_CMD) return `${OWNER}\n`
    if (cmd.startsWith('ps -o command=')) return chromeCmd // the client carries the same profile text: only the LISTEN filter can exclude it
    if (cmd.startsWith('ps -o pgid= -p')) return cmd.includes(String(OWNER)) ? `${OWNER}` : `${CLIENT}`
    return ''
  })
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    signalled.push([pid, sig])
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

const real = (): number[] => signalled.filter(([, s]) => s !== 0).map(([pid]) => Math.abs(pid))

describe('8468f7b1 [core-seam.9] default probe lists listeners with lsof -sTCP:LISTEN (commit 591e1a7)', () => {
  it('the execSync command string is exactly `lsof -ti tcp:<port> -sTCP:LISTEN 2>/dev/null` (591e1a7)', () => {
    expect(systemProcessProbe.listeners(PORT)).toEqual([OWNER])
    expect(commands[0]).toBe(LISTEN_CMD)
    expect(commands).not.toContain(OLD_CMD)
  })

  it('killChrome never signals a client pid reported only by the old lsof form, and signals the owner pid (591e1a7)', async () => {
    await killChrome(PORT, { profileDir: PROFILE })
    expect(real()).toContain(OWNER)
    expect(real()).not.toContain(CLIENT)
    expect(commands).toContain(LISTEN_CMD)
    expect(commands).not.toContain(OLD_CMD)
  })

  it('the fuser fallback after an empty lsof stays unchanged: fuser <port>/tcp (execSync, 591e1a7)', () => {
    m.execSync.mockImplementation((cmd: string) => {
      commands.push(cmd)
      return cmd === `fuser ${PORT}/tcp 2>/dev/null` ? `${OWNER}` : ''
    })
    expect(systemProcessProbe.listeners(PORT)).toEqual([OWNER])
    expect(commands).toEqual([LISTEN_CMD, `fuser ${PORT}/tcp 2>/dev/null`])
  })
})
