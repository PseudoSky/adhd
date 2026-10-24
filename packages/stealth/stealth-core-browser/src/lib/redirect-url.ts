/**
 * stealth-core-browser/src/lib/redirect-url.ts — search-result link normalization shared by the HTML parsers
 * and the DOM walker.
 */

/**
 * `decodeURIComponent` that cannot throw on page-supplied text: every run of valid `%XX` escapes is
 * decoded and a malformed run (a lone `%`, a truncated multi-byte sequence) keeps its undecodable bytes as written, so one
 * bad link never aborts the parse of a results page.
 */
export function safeDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      // A truncated or invalid multi-byte tail: keep it as written but still decode the ASCII escapes around it.
      return run.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    }
  })
}

/**
 * Unwrap a search engine's redirect link to the real target (DuckDuckGo `uddg=`, Google `/url?q=`) and absolutize
 * protocol-relative and Google `/goto` links. Any other link keeps its own query string: only the `/url` redirect
 * path carries `q=` as a target, so a site's relative `/search?q=foo` is returned unchanged.
 */
export function normalizeUrl(raw: string): string {
  if (!raw) return raw
  const ddg = raw.match(/[?&]uddg=([^&]+)/)
  if (ddg) return safeDecode(ddg[1])
  const ggl = raw.match(/^(?:https?:\/\/[^/]+)?\/url\?(?:[^#]*&)?q=([^&#]+)/)
  if (ggl) return safeDecode(ggl[1])
  if (raw.startsWith('//')) return 'https:' + raw
  if (raw.startsWith('/abs/')) return `https://arxiv.org${raw}`
  // Google's newer SERP wraps result links as an ENCRYPTED redirect
  // (`/goto?url=<opaque token>` — NOT client-decodable, unlike the `/url?q=`
  // form handled above). Absolutize it so the link is at least navigable
  // (Google 302s to the real target); without this, google results carry
  // unusable bare relative paths.
  if (raw.startsWith('/goto?url=')) return `https://www.google.com${raw}`
  return raw
}

