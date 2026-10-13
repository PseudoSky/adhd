# `/parsers` — Server-Side Response Parsers

The parsers module provides server-side extraction from HTML and JSON responses — no JavaScript injection, no CDP DOM dependency.

All parsing runs in the Node.js process, not in the browser.

**Preference order:**
1. **`extractWithXpath`** (xpath-based, `@xmldom/xmldom` + `xpath`) — preferred for HTML. Class-name independent, uses structural markers.
2. **`extractResultsFromJson`** (dot-path selectors) — for JSON APIs.
3. **`extractResultsFromHtml`** (class-based regex) — legacy, fragile. Use only when xpath can't work.
4. **`extractStructural`** (class-based DOM, `node-html-parser`) — deprecated.

## `extractWithXpath` — XPath Extraction (Preferred)

The recommended parser for HTML responses. Uses `@xmldom/xmldom` for server-side DOM + `xpath` for querying. No JS injection, no CDP dependency.

Optimized for Google search results but works with any provider when given the right XPath expression.

```typescript
import { extractWithXpath } from '@adhd/stealth-core-browser/parsers'

const html = await getSearchResponseBody()
const results = extractWithXpath(html)

for (const r of results) {
  console.log(`Title: ${r.title}`)
  console.log(`URL:   ${r.url}`)
  console.log(`Snippet: ${r.snippet}`)
}
```

### Default XPath (Google search results)

The built-in XPath expression targets Google's real search results (not sidebar links, video timestamps, or knowledge panels):

```
//*[local-name()='a' and @jsname][./*[local-name()='div']/*[local-name()='div']]
```

This matches only `a[jsname]` elements whose first child div has a child div — a structural marker that identifies real organic search results. Class names like `MjjYud` and `zReHs` rotate frequently; this XPath doesn't use them.

### Extraction algorithm

1. Parse HTML with `@xmldom/xmldom` (malformed HTML errors suppressed)
2. Select all matching `a[jsname]` elements with the `> div > div` structure
3. For each element:
   - **Title:** Find the first `h2` or `h3` heading text inside the anchor
   - **URL:** Read the `href` attribute from the anchor
   - **Snippet:** Walk up to the result card (up to 6 levels), find the first `div` with substantive text (>60 chars) that isn't the title or contains a URL
4. Deduplicate by URL
5. Normalize URLs (decode DuckDuckGo/Google redirects, handle `//` protocol-relative)

### URL normalization

```typescript
// Decodes DuckDuckGo redirect: ...?uddg=https%3A%2F%2Fexample.com
// Decodes Google redirect: ...?q=https%3A%2F%2Fexample.com (non-HTTP URLs)
// Protocol-relative: //example.com → https://example.com
// ArXiv: /abs/2301.12345 → https://arxiv.org/abs/2301.12345
```

### Error handling

If the HTML is so malformed that `@xmldom` throws (rare), the function returns an empty array gracefully.

## `extractResultsFromJson` — JSON Extraction

For JSON API responses (npm, crates, Wikipedia, Maven, etc.). Uses dot-path selectors to navigate the JSON structure.

```typescript
import { extractResultsFromJson } from '@adhd/stealth-core-browser/parsers'
import type { CaptureConfig } from '@adhd/stealth-core-browser/types'

const config: CaptureConfig = {
  urlPattern: 'api.npmjs.org',
  parser: 'json',
  resultSelector: 'objects',           // Path to the array of results
  fields: {
    title: 'package.name',             // Dot-path within each item
    url: 'package.links.npm',
    snippet: 'package.description',
  },
}

const json = await fetch('https://api.npmjs.org/...').then(r => r.text())
const results = extractResultsFromJson(json, config)
```

### `CaptureConfig` for JSON

```typescript
interface CaptureConfig {
  urlPattern: string
  parser: 'html' | 'json' | 'xml'
  /** Dot-path to the array of result items */
  resultSelector: string
  fields: {
    title: string       // Dot-path to title field
    url: string         // Dot-path to URL field
    snippet: string     // Dot-path to snippet/description field
    linkSelector?: string
    meta?: Record<string, string>
    clean?: {
      title?: { pattern: string; replace: string }
      snippet?: { pattern: string; replace: string }
    }
  }
  extraWaitMs?: number
  directFetch?: boolean
}
```

Dot-path resolution traverses the JSON structure. For example, `package.name` resolves as `data.package.name` from the root of each result item. Use `'*'` for `resultSelector` to use the entire parsed object as a single item.

## `extractResultsFromHtml` — Class-Based HTML Extraction (Legacy)

Uses regex-based extraction on raw HTML with tag+class selectors. Fragile — class names often rotate.

**Deprecated in favor of `extractWithXpath`.**

```typescript
import { extractResultsFromHtml } from '@adhd/stealth-core-browser/parsers'
import type { CaptureConfig } from '@adhd/stealth-core-browser/types'

const config: CaptureConfig = {
  urlPattern: 'example.com',
  parser: 'html',
  resultSelector: '',
  fields: {
    title: 'h3.result__title',          // tag[.class]
    url: 'a.result__link',              // tag[.class] with href
    snippet: 'p.result__snippet',
    linkSelector: 'a.result__link',     // Separate link selector when title and link are different elements
  },
}

const results = extractResultsFromHtml(htmlBody, config)
```

### Field selector format

Selectors use the format `tagname.classname` (e.g., `h3.result__title`). The class part is optional (`h3` matches any `<h3>` tag).

### Extraction passes

The function runs three extraction passes:

1. **Pass 1 (self-linking):** Matches elements where the link is on the same tag. E.g., `<a class="result__link" href="...">Title</a>`.
2. **Pass 2 (child-linking):** Matches elements where the link is on a child `<a>` tag. E.g., `<h3 class="title"><a href="...">Title</a></h3>`.
3. **Pass 3 (separate elements):** Matches when the title element and link element are separate siblings. E.g., `<h3>Title</h3> ... <a href="...">link</a>`. The nearest following link element is paired with each title.

### Snippet extraction

The snippet is extracted by looking within a ±5000 character window around the matched title element for the next occurrence of the snippet selector pattern.

## `extractStructural` — Class-Based DOM Parsing (Deprecated)

Uses `node-html-parser` to parse HTML into a DOM tree, then finds results using `a[jsname]` selectors. The same structural logic as `extractWithXpath` but using a class-based DOM library instead of xpath.

**Deprecated.** Use `extractWithXpath` instead.

```typescript
import { extractStructural } from '@adhd/stealth-core-browser/parsers'

// Same structural extraction as extractWithXpath, but via node-html-parser
const results = extractStructural(htmlBody, captureConfig)
```

## Shared Types

```typescript
interface ParseResult {
  title: string
  url: string
  snippet: string
  meta?: Record<string, string>
  source?: SearchResultSource
}

interface SearchResultSource {
  provider: string
  strategy: 'network' | 'dom'
  capturedUrl: string
  position: number
  capturedAt: string
}

interface DomPattern {
  tag?: string
  attrs?: Record<string, string | RegExp>
  text?: RegExp
}

interface DomExtractor {
  structural?: boolean
  container?: DomPattern
  title?: DomPattern & { attr?: string }
  link?: DomPattern & { attr: string }
  snippet?: DomPattern
  extra?: Record<string, DomPattern & { attr?: string }>
}

interface StructuralExtractor {
  rootSelector: string
  itemTag: string
  itemDepth: number
  headingTag: string
  linkTag: string
  snippetTag: string
  searchDepth: number
}

interface CaptureConfig {
  urlPattern: string
  parser: 'html' | 'json' | 'xml'
  resultSelector: string
  fields: {
    title: string
    url: string
    snippet: string
    linkSelector?: string
    meta?: Record<string, string>
    clean?: {
      title?: { pattern: string; replace: string }
      snippet?: { pattern: string; replace: string }
    }
  }
  extraWaitMs?: number
  directFetch?: boolean
}
```

## Choosing a Parser

| Parser | Input | Selector style | Stability | Recommended for |
|---|---|---|---|---|
| `extractWithXpath` | HTML | XPath | High (structural) | **Default for all HTML** |
| `extractResultsFromJson` | JSON | Dot-path | High | JSON APIs (npm, GitHub, etc.) |
| `extractResultsFromHtml` | HTML | `tag.class` | Low (class names change) | Legacy code only |
| `extractStructural` | HTML | Class-based DOM | Low | Deprecated — use xpath |

## Example: Full Pipeline (CDP Capture → XPath Parse)

```typescript
import { ensureChromeRunning, createPageTarget, closePageTarget } from '@adhd/stealth-core-browser/cdp'
import { captureNetworkResponse } from '@adhd/stealth-core-browser/capture'
import { extractWithXpath } from '@adhd/stealth-core-browser/parsers'

await ensureChromeRunning()
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')

try {
  const response = await captureNetworkResponse(pageWsUrl, {
    navigateUrl: 'https://www.google.com/search?q=typescript',
    urlPattern: /google\.com\/search/,
    timeoutMs: 10_000,
  })

  const results = extractWithXpath(response.body)
  console.log(`Found ${results.length} results`)
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title}`)
    console.log(`   ${r.url}`)
  })
} finally {
  await closePageTarget('127.0.0.1:9222', targetId)
}
```
