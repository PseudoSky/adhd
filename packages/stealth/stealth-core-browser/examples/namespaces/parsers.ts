/**
 * Scenario: response-to-result-rows -- turn a captured response into result rows without injecting any
 * script into the page: read it as a JSON API when it is JSON, otherwise as HTML,
 * and fall back to the structural XPath reader when the selectors find nothing.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { StealthCoreBrowserError, capture, cdp, parsers } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** URL the first open tab is sent to. */
  url: string
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
}

export interface ParsedRows {
  parser: 'json' | 'html' | 'xpath'
  rows: Array<{ title: string; url: string; snippet: string }>
}

export async function run({ url, host = '127.0.0.1', port = 9333 }: RunOptions): Promise<ParsedRows> {
  const [tab] = await cdp.listPageTargetsOnly(`${host}:${port}`)
  if (!tab?.webSocketDebuggerUrl) throw StealthCoreBrowserError.of('CDP_UNREACHABLE', `open a tab in the Chrome on port ${port} first`)
  const { body } = await capture.captureNetworkResponse(tab.webSocketDebuggerUrl, { urlPattern: /./, navigateUrl: url })

  const isJson = /^\s*[[{]/.test(body)
  const config = {
    urlPattern: '.*',
    parser: isJson ? ('json' as const) : ('html' as const),
    resultSelector: isJson ? 'items' : 'article',
    fields: isJson
      ? { title: 'name', url: 'href', snippet: 'summary' }
      : { title: 'h2', url: 'a', snippet: 'p' },
  }
  if (isJson) return { parser: 'json', rows: parsers.extractResultsFromJson(body, config) }

  const rows = parsers.extractResultsFromHtml(body, config)
  if (rows.length > 0) return { parser: 'html', rows }
  return { parser: 'xpath', rows: parsers.extractWithXpath(body) }
}
