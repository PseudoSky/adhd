/**
 * The typed error registry of @adhd/stealth-core-browser: one code per failure mode, a remediation message that names
 * a next step, a stable exit status, CaptureError and LifecycleError as members of the same family, and the launch
 * classifier (ENOENT, EADDRINUSE).
 * Ticket 8468f7b1 · [prod-errors.1] [prod-errors.2] [prod-errors.8] · PA5.1 / PA5.4.
 * Pure: no I/O.
 */
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, StealthCoreBrowserError, exitCodeFor } from '../../../errors.js'
import type { ErrorCode } from '../../../errors.js'
import { CAPTURE_ERROR_CODES, CaptureError } from '../../../lib/recording/errors.js'
import { LIFECYCLE_ERROR_CODES, LifecycleError, lifecycleErrors } from '../../../lib/lifecycle/errors.js'
import * as root from '../../../index.js'

const ENVIRONMENT = ['CHROME_NOT_FOUND', 'PORT_IN_USE', 'NODE_TOO_OLD', 'CHROME_NOT_RUNNING']
const LIBRARY = [
  'CHROME_START_TIMEOUT', 'CDP_UNREACHABLE', 'CDP_BAD_RESPONSE', 'TARGET_NOT_FOUND', 'CDP_CONNECT_FAILED', 'CDP_NOT_CONNECTED',
  'CDP_TIMEOUT', 'CDP_REMOTE_ERROR', 'CDP_SESSION_CLOSED', 'CDP_SEND_FAILED', 'NAVIGATION_FAILED', 'PAGE_SETTLE_FAILED',
  'OPERATION_ABORTED', 'SELECTOR_TIMEOUT',
]

describe('8468f7b1 [prod-errors.1] the ERROR_CODES registry (PA5.1)', () => {
  it('names exactly the 32 failure modes: 4 environment, 14 library, 8 capture, 6 lifecycle, in that order', () => {
    expect([...ERROR_CODES]).toEqual([...ENVIRONMENT, ...LIBRARY, ...CAPTURE_ERROR_CODES, ...LIFECYCLE_ERROR_CODES])
    expect(ERROR_CODES).toHaveLength(32)
    expect(new Set(ERROR_CODES).size).toBe(32)
  })

  it.each(ERROR_CODES)('%s carries its code and a remediation message that names a next step', (code) => {
    const e = new StealthCoreBrowserError(code, 'what went wrong')
    expect(e.code).toBe(code)
    expect(e.message).toBe('what went wrong')
    expect(e.remediation).toMatch(/\b(install|set|use|run|upgrade|start|free|choose|launch|update|retry|check|increase|pass|fix|remove|wait|keep|connect|open|reconnect|list)\b/i)
    expect(e.remediation.length).toBeGreaterThan(20)
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.name).toBe('StealthCoreBrowserError')
  })

  it('StealthCoreBrowserError.of puts the remediation after the summary in the message and keeps cause and detail', () => {
    const cause = new Error('root')
    const e = StealthCoreBrowserError.of('CDP_TIMEOUT', 'CDP timeout: Page.enable after 5ms', { cause, detail: { method: 'Page.enable' } })
    expect(e.message.startsWith('CDP timeout: Page.enable after 5ms — ')).toBe(true)
    expect(e.message.endsWith(e.remediation)).toBe(true)
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ method: 'Page.enable' })
  })

  it('reads no environment: the registry module carries no process.env access', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../../errors.ts', import.meta.url), 'utf8')
    expect(src.includes('process.env')).toBe(false)
  })
})

describe('8468f7b1 [prod-errors.6] exitCodeFor and the package root', () => {
  it('gives every code its own stable exit status above 1', () => {
    const statuses = ERROR_CODES.map((c) => exitCodeFor(c))
    expect(new Set(statuses).size).toBe(ERROR_CODES.length)
    for (const s of statuses) expect(s).toBeGreaterThan(1)
    expect(exitCodeFor('CHROME_NOT_FOUND')).toBe(10)
    expect(exitCodeFor('LAUNCH_CIRCUIT_OPEN')).toBe(63)
  })

  it('maps a code it does not know to exit status 1', () => {
    expect(exitCodeFor('SEARCH_SOMETHING')).toBe(1)
    expect(exitCodeFor('toString')).toBe(1)
  })

  it('exports StealthCoreBrowserError, ERROR_CODES and exitCodeFor from the package root', () => {
    expect(root.StealthCoreBrowserError).toBe(StealthCoreBrowserError)
    expect(root.ERROR_CODES).toBe(ERROR_CODES)
    expect(root.exitCodeFor).toBe(exitCodeFor)
    expect(Object.keys(root.recording)).toEqual(expect.arrayContaining(['NetworkRecorder', 'CaptureError', 'MemoryRecordingSink', 'StoreRecordingSink', 'openStoreRecordingSink', 'redactHeaders']))
  })
})

describe('8468f7b1 [prod-errors.8] CaptureError and LifecycleError are StealthCoreBrowserError (PA5.4)', () => {
  it.each(CAPTURE_ERROR_CODES)('CaptureError %s is a StealthCoreBrowserError with a remediation message and cause', (code) => {
    const cause = new Error('c')
    const e = new CaptureError(code, 'capture message', { cause, detail: { k: 1 } })
    expect(e).toBeInstanceOf(CaptureError)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.code).toBe(code)
    expect(e.name).toBe('CaptureError')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ k: 1 })
    expect(e.remediation.length).toBeGreaterThan(20)
  })

  it.each(LIFECYCLE_ERROR_CODES)('LifecycleError %s is a StealthCoreBrowserError with a remediation message and cause', (code) => {
    const cause = new Error('c')
    const e = new LifecycleError(code, 'lifecycle message', { cause, detail: { port: 9333 } })
    expect(e).toBeInstanceOf(LifecycleError)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.code).toBe(code)
    expect(e.name).toBe('LifecycleError')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ port: 9333 })
    expect(e.remediation.length).toBeGreaterThan(20)
  })

  it('a plain Error and a base error are told apart: only the family passes instanceof StealthCoreBrowserError', () => {
    expect(new Error('x') instanceof StealthCoreBrowserError).toBe(false)
    expect(new RangeError('x') instanceof StealthCoreBrowserError).toBe(false)
    expect(Object.create(null) instanceof StealthCoreBrowserError).toBe(false)
    expect(new CaptureError('CAPTURE_TIMEOUT', 'm') instanceof LifecycleError).toBe(false)
  })
})

describe('8468f7b1 [prod-errors.8] the launch classifier maps ENOENT to CHROME_NOT_FOUND and EADDRINUSE to PORT_IN_USE', () => {
  const classify = (e: unknown): ErrorCode => StealthCoreBrowserError.classifyLaunchFailure(e)

  it('a LAUNCH_FAILED whose cause has code ENOENT is CHROME_NOT_FOUND', () => {
    const spawnFailure = Object.assign(new Error('spawn /nope/chrome ENOENT'), { code: 'ENOENT' })
    expect(classify(lifecycleErrors.launchFailed(9333, spawnFailure))).toBe('CHROME_NOT_FOUND')
  })

  it('a LAUNCH_FAILED whose cause has code EADDRINUSE is PORT_IN_USE', () => {
    const listenFailure = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:9333'), { code: 'EADDRINUSE' })
    expect(classify(lifecycleErrors.launchFailed(9333, listenFailure))).toBe('PORT_IN_USE')
  })

  it('the code is found through a nested cause chain and through the message alone', () => {
    const inner = Object.assign(new Error('x'), { code: 'EADDRINUSE' })
    const mid = Object.assign(new Error('mid'), { cause: inner })
    expect(classify(Object.assign(new Error('outer'), { cause: mid }))).toBe('PORT_IN_USE')
    expect(classify(new Error('spawn chrome ENOENT'))).toBe('CHROME_NOT_FOUND')
  })

  it('a typed CHROME_NOT_FOUND cause classifies as CHROME_NOT_FOUND', () => {
    const typed = new StealthCoreBrowserError('CHROME_NOT_FOUND', 'Chrome binary not found')
    expect(classify(lifecycleErrors.launchFailed(9333, typed))).toBe('CHROME_NOT_FOUND')
  })

  it('any other launch failure keeps its own code, and an untyped one is LAUNCH_FAILED', () => {
    expect(classify(lifecycleErrors.circuitOpen(9333, 5000))).toBe('LAUNCH_CIRCUIT_OPEN')
    expect(classify(lifecycleErrors.launchFailed(9333, new Error('boom')))).toBe('LAUNCH_FAILED')
    expect(classify(new Error('boom'))).toBe('LAUNCH_FAILED')
    expect(classify('plain string')).toBe('LAUNCH_FAILED')
    expect(classify(undefined)).toBe('LAUNCH_FAILED')
  })

  it('a cyclic cause chain terminates', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' }
    a.cause = a
    expect(classify(a)).toBe('LAUNCH_FAILED')
  })
})

describe('8468f7b1 [prod-errors.8] the invalid-endpoint error is both a RangeError and a package error', () => {
  it('invalidEndpoint passes instanceof RangeError and instanceof StealthCoreBrowserError with a CDP_UNREACHABLE code and reason', () => {
    const e = StealthCoreBrowserError.invalidEndpoint('port must be an integer between 1 and 65535, got 0')
    expect(e).toBeInstanceOf(RangeError)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.code).toBe('CDP_UNREACHABLE')
    expect(e.detail).toEqual({ reason: 'invalid-endpoint' })
    expect(e.message).toMatch(/^port must be an integer/)
    expect(e.message).toMatch(/launchChrome/)
  })
})
