/**
 * Scenario: capture-and-ban-check -- capture the real network response of a page load, check it for a
 * CAPTCHA or rate-limit wall, and decide whether the job should retry or give up.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { StealthCoreBrowserError, capture, cdp } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** URL the first open tab is sent to. */
  url: string
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
}

export interface CaptureReport {
  status: number
  bytes: number
  /** The ban signal found in the response, or null for a clean page. */
  ban: string | null
  retry: { shouldRetry: boolean; delayMs: number; reason: string }
}

export async function run({ url, host = '127.0.0.1', port = 9333 }: RunOptions): Promise<CaptureReport> {
  const [tab] = await cdp.listPageTargetsOnly(`${host}:${port}`)
  if (!tab?.webSocketDebuggerUrl) throw StealthCoreBrowserError.of('CDP_UNREACHABLE', `open a tab in the Chrome on port ${port} first`)

  const response = await capture.captureNetworkResponse(tab.webSocketDebuggerUrl, {
    urlPattern: /./,
    navigateUrl: url,
    timeoutMs: 10_000,
  })

  const rules = [
    { name: 'captcha-wall', signal: 'captcha' as const, checkBody: /unusual traffic|are you a robot/i },
    { name: 'rate-limit', signal: 'rate_limited' as const, checkStatus: [429] },
  ]
  const ban = capture.checkBans(rules, { url: response.url, status: response.status, body: response.body })
  const retry = capture.decideRetry({ outcome: ban ?? 'success' }, 1, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    onCaptcha: 'retry',
    onRateLimit: 'retry',
    onTimeout: 'retry',
    onBan: 'abort',
  })
  return { status: response.status, bytes: response.body.length, ban, retry }
}
