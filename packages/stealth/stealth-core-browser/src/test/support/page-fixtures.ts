/**
 * Realistic page and network-trace fixtures for the use-case lane.
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.3]
 *
 * Page shapes (all synthetic, labelled `synthetic-protocol-conformant` through the CDP fixture meta):
 *   1. articleListHtml      server-rendered result list (article > h2 / a / p)
 *   2. embeddedDataPageHtml code-search style page carrying its rows as embedded application/json
 *   3. captchaWallHtml      an interstitial "unusual traffic" wall
 *   4. emptyShellHtml       a script-only app shell with nothing to read
 *   5. serpResultsHtml      a search-engine result page the structural XPath reader understands
 *   6. searchApiTrace       a JSON API response (items[]) as a CDP trace
 * `pageTraceFor` turns any body into a complete CDP protocol trace for the shared FakeCdpServer.
 */
import { loadFixture, type CdpFixture } from './fake-cdp.js'

export const SITE_URL = 'https://site.test/home'

export const articleListHtml = `<!doctype html>
<html lang="en"><head><title>Release notes</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <main>
    <article><h2>Alpha release</h2><a href="https://a.test/alpha">read</a><p>First public build</p></article>
    <article><h2>Beta release</h2><a href="https://b.test/beta">read</a><p>Second public build</p></article>
    <article><h2>Gamma release</h2><a href="https://g.test/gamma">read</a><p>Third public build</p></article>
  </main>
</body></html>`

const embeddedRows = {
  payload: {
    results: [
      { repo_nwo: 'acme/widgets', ref_name: 'refs/heads/main', path: 'src/index.ts', hl_name: 'acme/<em>widgets</em>', snippets: [{ lines: ['export const <em>widget</em> = 1'] }] },
      { repo_nwo: 'acme/gears', ref_name: 'refs/heads/main', path: 'lib/gear.ts', hl_name: 'acme/gears', snippets: [{ lines: ['export function gear() {}'] }] },
    ],
  },
}

export const embeddedDataPageHtml = `<!doctype html>
<html><head><title>Code search</title></head><body>
<div id="app"></div>
<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(embeddedRows)}</script>
</body></html>`

export const serpResultsHtml = `<!doctype html>
<html><head><title>widgets - Search</title></head><body><div id="search">
  <div class="card">
    <a jsname="UWckNb" href="https://widgets.test/guide"><div><div><h3>The widget guide</h3></div></div></a>
    <div><div>A long form walkthrough of building widgets from scratch, covering the tooling, the packaging and the release process in detail.</div></div>
    <span>spacer</span>
  </div>
  <div class="card">
    <a jsname="UWckNb" href="https://gears.test/intro"><div><div><h3>Gears for beginners</h3></div></div></a>
    <div><div>An introduction to gears, ratios and torque with worked examples that a newcomer can follow without any prior mechanical background.</div></div>
    <span>spacer</span>
  </div>
</div></body></html>`

export const captchaWallHtml = `<!doctype html>
<html><head><title>Before you continue</title></head><body>
<h1>Our systems have detected unusual traffic from your computer network.</h1>
<form action="/sorry"><div class="g-recaptcha"></div></form>
</body></html>`

export const emptyShellHtml = `<!doctype html>
<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`

export const searchApiBody = JSON.stringify({
  items: [
    { name: 'Alpha', href: 'https://a.test/', summary: 'first' },
    { name: 'Beta', href: 'https://b.test/', summary: 'second' },
    { name: 'Gamma', href: 'https://g.test/', summary: 'third' },
  ],
})

export interface TraceOptions {
  status?: number
  mimeType?: string
  /** A header added to the main request (e.g. a session cookie). */
  requestHeaders?: Record<string, string>
}

/** A complete CDP trace (navigate, request, response, finish, body) that serves `body` for `SITE_URL`. */
export function pageTraceFor(body: string, opts: TraceOptions = {}): CdpFixture {
  const f = loadFixture('doc-200')
  for (const step of f.steps) {
    if (step.when.method === 'Network.getResponseBody') step.reply = { result: { body, base64Encoded: false } }
    for (const ev of step.emit ?? []) {
      const params = ev.params as { request?: { headers: Record<string, string> }; response?: { status: number; mimeType: string; headers: Record<string, string> } }
      if (ev.method === 'Network.requestWillBeSent' && params.request) Object.assign(params.request.headers, opts.requestHeaders ?? {})
      if (ev.method === 'Network.responseReceived' && params.response) {
        if (opts.status !== undefined) params.response.status = opts.status
        if (opts.mimeType !== undefined) {
          params.response.mimeType = opts.mimeType
          params.response.headers['content-type'] = opts.mimeType
        }
      }
    }
  }
  return f
}

export const searchApiTrace = (): CdpFixture => pageTraceFor(searchApiBody, { mimeType: 'application/json' })
export const articleListTrace = (): CdpFixture => pageTraceFor(articleListHtml, { mimeType: 'text/html' })
export const captchaWallTrace = (): CdpFixture => pageTraceFor(captchaWallHtml, { status: 200 })
export const rateLimitedTrace = (): CdpFixture => pageTraceFor('slow down', { status: 429, mimeType: 'text/plain' })
