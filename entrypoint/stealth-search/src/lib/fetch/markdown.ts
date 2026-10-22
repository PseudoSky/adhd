/**
 * @adhd/stealth-search — src/lib/fetch/markdown.ts
 *
 * HTML to markdown for the fetch provider (inventory I-29, [search-port-fetch.4]).
 *
 *  - Turndown, ONE lazily constructed instance, removing exactly four tags.
 *  - Input capped at 1 MiB (1048576 characters) BEFORE conversion; overflow appends a truncation marker.
 *  - On ANY throw the conversion degrades to a cleaned-text reduction instead of failing.
 *
 * Ticket 8468f7b1 · plan state search-port-fetch.
 */

/** The Turndown input cap: 1 MiB. */
export const TURNDOWN_INPUT_CAP = 1_048_576
/** Appended to markdown whose HTML input was cut at the cap. */
export const TRUNCATION_MARKER = '\n\n[Content truncated due to length...]'

/** The slice of Turndown this module uses. */
export interface TurndownLike {
  turndown(html: string): string
}

/** Loads a ready Turndown instance (injectable for tests). */
export type TurndownLoader = () => Promise<TurndownLike>

interface TurndownCtor {
  new (options: Record<string, unknown>): TurndownLike & { remove(tags: string[]): unknown }
}

let turndownPromise: Promise<TurndownLike> | null = null

/** Lazily build one Turndown instance; the four removed tags match the reference WebFetch. */
const defaultLoader: TurndownLoader = () =>
  (turndownPromise ??= import('turndown').then((mod) => {
    // CJS interop: depending on the module emit, the constructor is `default` or the module itself.
    const Ctor = ((mod as unknown as { default?: TurndownCtor }).default ?? (mod as unknown as TurndownCtor))
    const td = new Ctor({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    td.remove(['style', 'script', 'noscript', 'iframe'])
    return td
  }))

/** Last-resort cleaner when Turndown is unavailable or throws. */
export function cleanHtmlFallback(html: string): string {
  return html
    .replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The converted document. */
export interface MarkdownResult {
  markdown: string
  /** How the conversion was produced, so callers know the quality. */
  via: 'turndown' | 'fallback'
  /** True when the input exceeded the cap and was cut (the marker is appended to `markdown`). */
  truncated: boolean
}

/** Convert an HTML document to markdown. Never throws: a conversion failure degrades to cleaned text. */
export async function htmlToMarkdown(html: string, load: TurndownLoader = defaultLoader): Promise<MarkdownResult> {
  const truncated = html.length > TURNDOWN_INPUT_CAP
  const input = truncated ? html.slice(0, TURNDOWN_INPUT_CAP) : html
  try {
    const td = await load()
    let md = td.turndown(input)
    if (truncated) md += TRUNCATION_MARKER
    return { markdown: md, via: 'turndown', truncated }
  } catch {
    let md = cleanHtmlFallback(input)
    if (truncated) md += TRUNCATION_MARKER
    return { markdown: md, via: 'fallback', truncated }
  }
}
