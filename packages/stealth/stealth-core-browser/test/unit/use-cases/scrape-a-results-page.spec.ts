/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 * Exercises AC4 (capture without script injection), PA4.1 (server-side parsers) and PA8.2 (no Runtime.evaluate).
 *
 * A scraper loads three differently shaped pages in the controlled Chrome and turns each captured response
 * into result rows: a JSON API, a server-rendered article list and a page carrying its data as embedded JSON,
 * then meets a script-only shell with nothing to read.
 * guards: [tests-use-cases.2] reads a JSON API response into rows
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capture, cdp, parsers } from '../../../src/index.js'
import type { CaptureConfig } from '../../../src/lib/types.js'
import { loadFixture } from '../../helpers/fake-cdp.js'
import { articleListHtml, articleListTrace, emptyShellHtml, embeddedDataPageHtml, pageTraceFor, searchApiTrace, serpResultsHtml, SITE_URL } from '../../helpers/page-fixtures.js'
import { ChromeWorld } from '../../helpers/use-cases/scenario-kit.js'

const world = new ChromeWorld(9403)

beforeEach(() => {
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'about:blank')]
})
afterEach(() => world.dispose())

async function load(fixture: ReturnType<typeof searchApiTrace>): Promise<{ body: string; methods: string[] }> {
  const server = world.useCdp(fixture)
  const [tab] = await cdp.listPageTargetsOnly(`127.0.0.1:${world.port}`)
  const response = await capture.captureNetworkResponse(tab!.webSocketDebuggerUrl!, { urlPattern: /./, navigateUrl: SITE_URL })
  return { body: response.body, methods: server.received.map((r) => r.method) }
}

const cfg = (c: Partial<CaptureConfig> & Pick<CaptureConfig, 'resultSelector' | 'fields'>): CaptureConfig =>
  ({ urlPattern: '.*', parser: 'html', ...c }) as CaptureConfig

describe('Scenario: scrape result rows from three kinds of page without injecting script', () => {
  it('[tests-use-cases.2] reads a JSON API response into rows', async () => {
    const { body, methods } = await load(searchApiTrace())
    const rows = parsers.extractResultsFromJson(body, cfg({ parser: 'json', resultSelector: 'items', fields: { title: 'name', url: 'href', snippet: 'summary' } }))
    expect(rows.map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(rows[1]).toMatchObject({ url: 'https://b.test/', snippet: 'second' })
    expect(methods).not.toContain('Runtime.evaluate')
  })

  it('[tests-use-cases.2] reads a server-rendered article list with CSS-style selectors', async () => {
    const { body } = await load(articleListTrace())
    expect(body).toBe(articleListHtml)
    const rows = parsers.extractResultsFromHtml(body, cfg({ resultSelector: 'article', fields: { title: 'h2', url: 'a', snippet: 'p' } }))
    expect(rows.map((r) => r.title)).toEqual(['Alpha release', 'Beta release', 'Gamma release'])
    expect(rows[0]).toMatchObject({ url: 'https://a.test/alpha', snippet: 'First public build' })
    expect(rows[2]!.url).toBe('https://g.test/gamma')
  })

  it('[tests-use-cases.2] reads rows embedded as application/json in a code-search style page', async () => {
    const { body } = await load(pageTraceFor(embeddedDataPageHtml, { mimeType: 'text/html' }))
    const rows = parsers.extractResultsFromEmbeddedJson(body, cfg({ parser: 'embedded-json', resultSelector: 'payload.results', fields: { title: 'hl_name', url: 'repo_nwo', snippet: '_snippet' } }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'acme/widgets', url: 'https://github.com/acme/widgets/blob/main/src/index.ts' })
    expect(rows[0]!.snippet).toContain('widget')
  })

  it('[tests-use-cases.2] falls back to the structural XPath reader, and a script-only shell yields nothing', async () => {
    const html = await load(articleListTrace())
    expect(parsers.extractWithXpath(html.body)).toEqual([])
    const serp = await load(pageTraceFor(serpResultsHtml))
    const found = parsers.extractWithXpath(serp.body)
    expect(found.map((r) => r.title)).toEqual(['The widget guide', 'Gears for beginners'])
    expect(found[0]).toMatchObject({ url: 'https://widgets.test/guide' })
    expect(found[0]!.snippet).toContain('walkthrough')
    const shell = await load(pageTraceFor(emptyShellHtml))
    expect(parsers.extractWithXpath(shell.body)).toEqual([])
    expect(parsers.extractResultsFromHtml(shell.body, cfg({ resultSelector: 'article', fields: { title: 'h2', url: 'a', snippet: 'p' } }))).toEqual([])
    expect(parsers.extractResultsFromJson('<html>', cfg({ parser: 'json', resultSelector: 'items', fields: { title: 'n', url: 'u', snippet: 's' } }))).toEqual([])
  })

  it('[tests-use-cases.3] the page shapes are distinct and the base trace is the shared harness fixture', () => {
    expect(new Set([articleListHtml, embeddedDataPageHtml, emptyShellHtml, serpResultsHtml]).size).toBe(4)
    expect(loadFixture('doc-200').meta.origin).toBe('synthetic-protocol-conformant')
  })
})
