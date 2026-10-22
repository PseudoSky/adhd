/**
 * Scenario: keep a replayable record of a page load for later debugging, with
 * credentials masked before anything is stored: a recording sink collects the
 * exchange and the redactor hides cookies and authorization headers.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { StealthCoreBrowserError, capture, cdp, recording } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** URL the first open tab is sent to. */
  url: string
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
}

export interface RecordedLoad {
  /** Number of exchanges stored by the sink. */
  stored: number
  /** The recorded request headers, credentials masked. */
  requestHeaders: Record<string, string>
  /** The mask that replaced each credential header. */
  mask: string
}

export async function run({ url, host = '127.0.0.1', port = 9333 }: RunOptions): Promise<RecordedLoad> {
  const [tab] = await cdp.listPageTargetsOnly(`${host}:${port}`)
  if (!tab?.webSocketDebuggerUrl) throw StealthCoreBrowserError.of('CDP_UNREACHABLE', `open a tab in the Chrome on port ${port} first`)

  const sink = new recording.MemoryRecordingSink()
  await capture.captureNetworkResponse(tab.webSocketDebuggerUrl, {
    urlPattern: /./,
    navigateUrl: url,
    sink,
    redact: recording.redactHeaders(['cookie', 'authorization']),
  })

  const records = sink.records()
  return { stored: records.length, requestHeaders: records[0]?.exchange.request.headers ?? {}, mask: recording.REDACTED }
}
