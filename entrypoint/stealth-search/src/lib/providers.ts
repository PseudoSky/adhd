/**
 * @adhd/stealth-search — src/lib/providers.ts
 *
 * The twelve registered providers and their extractor configs. Each defines a primary and an
 * optional fallback strategy:
 *   network (default) — capture the HTTP response body and parse it (HTML, JSON, embedded JSON)
 *   dom     (fallback) — walk the DOM tree via the CDP DOM domain
 *
 * Strategy by provider rationale:
 *   Static HTML providers: network (getResourceContent) — single GET, no JS
 *   JSON API providers:    network (direct fetch) — public REST API, no browser
 *   SPA providers:         DOM tree walk — JS-rendered, network capture cannot see it
 *   GitHub repositories:   REST API primary; rendered search page (embedded JSON) fallback
 *
 * The GitHub code-search configuration is an OVERRIDE object produced by `resolveProvider`
 * (utils.ts); it is never a thirteenth registered id.
 *
 * Inventory rows: I-22 (twelve providers, getProvider throws on unknown), I-22.a (github
 * repository search: API primary, fallbackNetwork fallback, no dom config).
 * Ticket 8468f7b1 · plan state search-port-providers · commits 591e1a7, c00edea.
 */
import { searchError } from '../errors.js'
import type { ProviderConfig } from './types.js'

export const PROVIDERS = {
  // ─── DuckDuckGo (HTML-only endpoint - static HTML, no JS needed) ────────────
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    help: 'General web search (via html.duckduckgo.com). Supports site:, intitle:, filetype: operators.',
    qualifierExamples: ['site:example.com    Search within a site', 'filetype:pdf        Filter by file type', 'intitle:hello       Title must contain'],
    url: (q) => `https://html.duckduckgo.com/html?q=${encodeURIComponent(q)}`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'html.duckduckgo.com/html',
      parser: 'html',
      resultSelector: 'div.result',
      fields: {
        title: 'a.result__a',
        url: 'a.result__a',
        snippet: 'a.result__snippet',
      },
      extraWaitMs: 0,
    },
    dom: {
      waitFor: '.result',
      extract: {
        container: { tag: 'DIV', attrs: { class: /(^|\s)result(\s|$)/ } },
        title: { tag: 'A', attrs: { class: /(^|\s)result__a(\s|$)/ } },
        link: { tag: 'A', attrs: { class: /(^|\s)result__url(\s|$)/ }, attr: 'href' },
        snippet: { tag: 'A', attrs: { class: /(^|\s)result__snippet(\s|$)/ } },
      },
    },
    bans: [
      { name: 'ddg-captcha', signal: 'captcha', checkUrl: /\/challenge/ },
      { name: 'ddg-block', signal: 'captcha', checkBody: /select all squares/i },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
      { name: 'cloudflare-blocked', signal: 'banned', checkBody: /Attention Required! \| Cloudflare|Error 1020|error code: 1020|\/cdn-cgi\/error\//i },
    ],
    // On CAPTCHA: use HITL — user sees DDG's "select squares" challenge in
    // the browser, solves it, comes back and the retry succeeds because the
    // Chrome profile now has a valid session cookie.
    retry: { maxAttempts: 3, baseDelayMs: 2000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── Google (network-first, xpath extraction) ────────────────────────────
  // Primary strategy is network capture — the initial HTML page contains search
  // results rendered server-side (the JS snippet expansion is non-essential).
  // extractWithXpath uses @xmldom/xmldom + xpath to extract from the structural
  // HTML response. Falls back to DOM tree walk when network capture times out.
  google: {
    id: 'google',
    name: 'Google',
    help: 'General web search (via google.com). Supports site:, filetype:, intitle:, inurl: operators.',
    qualifierExamples: ['site:example.com    Search within a site', 'filetype:pdf        Filter by file type', 'intitle:hello       Title must contain'],
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'www.google.com/search',
      parser: 'html',
      resultSelector: '#rso',
      fields: { title: '', url: '', snippet: '' },
      extraWaitMs: 500,
    },
    dom: {
      waitFor: '#search',
      structural: true,
      extract: {
        container: { tag: 'DIV' },
        title: { tag: 'A' },
        link: { tag: 'A', attr: 'href' },
        snippet: { tag: 'DIV' },
      },
    },
    bans: [
      { name: 'google-captcha', signal: 'captcha', checkUrl: /\/sorry\// },
      { name: 'google-captcha-body', signal: 'captcha', checkBody: /unusual traffic/i },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
      { name: 'cloudflare-blocked', signal: 'banned', checkBody: /Attention Required! \| Cloudflare|Error 1020|error code: 1020|\/cdn-cgi\/error\//i },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 3000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── ArXiv (static HTML) ────────────────────────────────────────────────────
  arxiv: {
    id: 'arxiv',
    name: 'arXiv',
    help: 'Academic papers (via arxiv.org). Supports au:, ti:, cat: operators.',
    qualifierExamples: ['au:smith            Author search', 'ti:quantum          Title search', 'cat:cs.AI           Category search'],
    url: (q) => `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'arxiv.org/search/',
      parser: 'html',
      resultSelector: 'li.arxiv-result',
      fields: {
        title: 'p.title',
        url: 'a[href^="/abs/"]',
        snippet: 'span.abstract-short',
        clean: {
          title: { pattern: '^arXiv:[^ ]+\\s*\\[?pdf,?\\s*ps,?\\s*other\\]?\\s*', replace: '' },
        },
      },
      extraWaitMs: 0,
    },
    dom: {
      waitFor: '.arxiv-result',
      extract: {
        container: { tag: 'LI', attrs: { class: 'arxiv-result' } },
        title: { tag: 'P', attrs: { class: 'title' } },
        link: { tag: 'A', attrs: { href: /^\/abs\// }, attr: 'href' },
        snippet: { tag: 'SPAN', attrs: { class: 'abstract-short' } },
        extra: { authors: { tag: 'P', attrs: { class: 'authors' } } },
      },
    },
    bans: [
      { name: 'arxiv-captcha', signal: 'captcha', checkUrl: /captcha|challenge/i },
      { name: 'arxiv-rate', signal: 'rate_limited', checkStatus: [429, 503] },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
      { name: 'cloudflare-blocked', signal: 'banned', checkBody: /Attention Required! \| Cloudflare|Error 1020|error code: 1020|\/cdn-cgi\/error\//i },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 2000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── npm (direct fetch to registry API — no browser needed) ────────────────
  npm: {
    id: 'npm',
    name: 'npm',
    help: 'npm packages (via registry.npmjs.org API). Direct fetch. Qualifiers: author:, maintainer:, keywords:, scope:, is:unstable, not:unstable, not:insecure, boost-exact:false.',
    qualifierExamples: ['author:bcoe         Filter by author', 'maintainer:bcoe     Filter by maintainer', 'keywords:cli        Filter by keywords (OR with comma, AND with +)', 'scope:foo           Search within a scope (@foo)', 'is:unstable         Include pre-1.0 packages', 'not:unstable        Exclude pre-1.0 packages', 'not:insecure        Exclude packages with vulnerabilities', 'boost-exact:false   Don\'t boost exact name matches'],
    url: (q) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=10`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'registry.npmjs.org/-/v1/search',
      parser: 'json',
      resultSelector: 'objects',
      fields: {
        title: 'package.name',
        url: 'package.links.npm',
        snippet: 'package.description',
        meta: { version: 'package.version', publisher: 'publisher.username' },
      },
      directFetch: true,
      extraWaitMs: 0,
    },
    dom: {
      waitFor: '._9d3f0e0e',
      extract: {
        container: { tag: 'A', attrs: { class: /_9d3f0e0e/ } },
        title: { tag: 'H3' },
        link: { tag: 'A', attrs: { href: /^\/package\// }, attr: 'href' },
        snippet: { tag: 'P' },
      },
    },
    bans: [
      { name: 'npm-rate', signal: 'rate_limited', checkStatus: [429] },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 2000, onCaptcha: 'abort', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── GitHub (JS-rendered SPA — DOM strategy with API fallback) ───────────
  github: {
    id: 'github',
    name: 'GitHub',
    help: 'GitHub search — repos by default. Use qualifier "type:code" for code search, "type:repositories" to stay explicit. Qualifiers: repo:, org:, user:, language:, license:, is:, path:, symbol:, regex. See docs.github.com/en/search-github (code search).',
    qualifierExamples: ['type:code           Code search (default: repos)', 'repo:owner/name     Search within a repo', 'org:name            Search within an org', 'user:name           Search within a user', 'language:go         Filter by language', 'license:MIT         Filter by license', 'is:archived         Include archived repos', 'NOT is:fork         Exclude forks', 'path:src/*.ts       Filter by file path (glob)', 'symbol:MyFunction   Search symbol definitions', '/pattern/           Use regex in terms and qualifiers'],
    url: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
    // Primary: the public REST search API (no browser). Fallback: the rendered search
    // page, whose results ride in the react-app.embeddedData JSON island. Both are
    // data channels, so no markup or class names are involved.
    strategies: { primary: 'network', fallback: 'network' },
    network: {
      urlPattern: 'api.github.com/search/repositories',
      parser: 'json',
      resultSelector: 'items',
      fields: {
        title: 'full_name',
        url: 'html_url',
        snippet: 'description',
        meta: { stars: 'stargazers_count', language: 'language', forks: 'forks_count', updated: 'updated_at' },
      },
      directFetch: true,
      apiUrl: 'https://api.github.com/search/repositories?q=',
      extraWaitMs: 0,
    },
    fallbackNetwork: {
      urlPattern: 'github.com/search\\?',
      parser: 'embedded-json',
      resultSelector: 'payload.blackbirdSearchRoute.results',
      // `{path}` placeholders are resolved against each result item (see extractResultsFromEmbeddedJson).
      fields: {
        title: '{repo.repository.owner_login}/{repo.repository.name}',
        url: 'https://github.com/{repo.repository.owner_login}/{repo.repository.name}',
        snippet: 'hl_trunc_description',
        // `followers` is the repo's star count on the search route (83351 for vitejs/vite,
        // equal to the REST API's stargazers_count at the same time).
        meta: { stars: 'followers', language: 'language', updated: 'repo.repository.updated_at' },
      },
      dataTarget: 'react-app.embeddedData',
      extraWaitMs: 0,
    },
    bans: [
      { name: 'github-rate', signal: 'rate_limited', checkStatus: [429, 403] },
      { name: 'github-login', signal: 'login_required', checkUrl: /\/login\// },
    ],
    retry: { maxAttempts: 2, baseDelayMs: 3000, onCaptcha: 'abort', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── Maven Central (direct fetch to Solr JSON API) ─────────────────────────
  maven: {
    id: 'maven',
    name: 'Maven Central',
    help: 'Java/Maven packages (via search.maven.org Solr API). Direct fetch. Qualifiers: g: (groupId), a: (artifactId), v: (version), p: (packaging), l: (classifier).',
    qualifierExamples: ['g:com.example       Filter by groupId', 'a:my-lib            Filter by artifactId', 'v:1.0.0             Filter by version', 'p:jar               Filter by packaging type', 'l:sources           Filter by classifier'],
    url: (q) => `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(q)}&rows=10&wt=json`,
    strategies: { primary: 'network' },
    network: {
      urlPattern: 'search.maven.org/solrsearch/select',
      parser: 'json',
      resultSelector: 'response.docs',
      fields: {
        title: 'a',
        url: 'id',
        snippet: 'latestVersion',
        meta: { groupId: 'g', artifactId: 'a', version: 'latestVersion' },
      },
      directFetch: true,
      extraWaitMs: 0,
    },
    bans: [
      { name: 'maven-rate', signal: 'rate_limited', checkStatus: [429] },
    ],
    retry: { maxAttempts: 2, baseDelayMs: 2000, onCaptcha: 'abort', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── Wikipedia (direct fetch to REST API) ───────────────────────────────────
  wikipedia: {
    id: 'wikipedia',
    name: 'Wikipedia',
    help: 'Wikipedia articles (via en.wikipedia.org API). Direct fetch. Free text search — no inline qualifiers.',
    qualifierExamples: [],
    url: (q) =>
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=10`,
    strategies: { primary: 'network' },
    network: {
      urlPattern: 'en.wikipedia.org/w/api.php',
      parser: 'json',
      resultSelector: 'query.search',
      fields: {
        title: 'title',
        url: 'pageid',
        snippet: 'snippet',
        urlTemplate: 'https://en.wikipedia.org/?curid={}',
      },
      directFetch: true,
      extraWaitMs: 0,
    },
    bans: [
      { name: 'wiki-rate', signal: 'rate_limited', checkStatus: [429] },
    ],
    retry: { maxAttempts: 2, baseDelayMs: 2000, onCaptcha: 'abort', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── crates.io (direct fetch to REST API) ───────────────────────────────────
  crates: {
    id: 'crates',
    name: 'crates.io',
    help: 'Rust crates (via crates.io API). Direct fetch. Free text search — no inline qualifiers.',
    qualifierExamples: [],
    url: (q) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=10`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'crates.io/api/v1/crates',
      parser: 'json',
      resultSelector: 'crates',
      fields: {
        title: 'name',
        url: 'id',
        snippet: 'description',
        meta: { version: 'max_version', downloads: 'downloads' },
      },
      directFetch: true,
      extraWaitMs: 0,
    },
    dom: {
      waitFor: '.crate',
      extract: {
        container: { tag: 'DIV', attrs: { class: 'crate' } },
        title: { tag: 'H2' },
        link: { tag: 'A', attrs: { class: 'name' }, attr: 'href' },
        snippet: { tag: 'DIV', attrs: { class: 'description' } },
        extra: {
          version: { tag: 'SPAN', attrs: { class: 'version' } },
          downloads: { tag: 'SPAN', attrs: { class: 'downloads' } },
        },
      },
    },
    bans: [
      { name: 'crates-rate', signal: 'rate_limited', checkStatus: [429] },
    ],
    retry: { maxAttempts: 2, baseDelayMs: 2000, onCaptcha: 'abort', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── PyPI (public JSON API) ────────────────────────────────────────────────
  pypi: {
    id: 'pypi',
    name: 'PyPI',
    help: 'Python packages (via pypi.org search). Free text search — no inline qualifiers.',
    qualifierExamples: [],
    url: (q) => `https://pypi.org/search/?q=${encodeURIComponent(q)}`,
    strategies: { primary: 'network', fallback: 'dom' },
    network: {
      urlPattern: 'pypi.org/search/',
      parser: 'html',
      resultSelector: 'a.package-snippet',
      fields: {
        title: 'span.package-snippet__name',
        url: 'a.package-snippet',
        // PyPI emits RELATIVE hrefs (`/project/requests/`); the HTML parser has
        // no page URL to absolutize against, so a urlTemplate is required.
        urlTemplate: 'https://pypi.org{}',
        snippet: 'span.package-snippet__description',
        meta: { version: 'span.package-snippet__version' },
      },
      extraWaitMs: 3000,  // Cloudflare managed challenge needs ~2-3s to auto-clear
    },
    dom: {
      waitFor: '.package-snippet',
      extract: {
        container: { tag: 'A', attrs: { class: 'package-snippet' } },
        title: { tag: 'SPAN', attrs: { class: 'package-snippet__name' } },
        link: { tag: 'A', attrs: { class: 'package-snippet' }, attr: 'href' },
        snippet: { tag: 'SPAN', attrs: { class: 'package-snippet__description' } },
        extra: {
          version: { tag: 'SPAN', attrs: { class: 'package-snippet__version' } },
        },
      },
    },
    bans: [
      { name: 'pypi-rate', signal: 'rate_limited', checkStatus: [429] },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
      { name: 'cloudflare-blocked', signal: 'banned', checkBody: /Attention Required! \| Cloudflare|Error 1020|error code: 1020|\/cdn-cgi\/error\//i },
    ],
    retry: { maxAttempts: 2, baseDelayMs: 2000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── MDN (via site:google.com — structural) ────────────────────────────────
  mdn: {
    id: 'mdn',
    name: 'MDN',
    help: 'MDN Web Docs (via Google site search). Google qualifiers apply: site:, filetype:, intitle:, inurl:.',
    qualifierExamples: ['site:example.com    Search within a site (in addition to MDN/SO)', 'filetype:pdf        Filter by file type', 'intitle:hello       Title must contain'],
    url: (q) => `https://www.google.com/search?q=site%3Adeveloper.mozilla.org+${encodeURIComponent(q)}&hl=en`,
    strategies: { primary: 'dom', fallback: 'network' },
    network: {
      urlPattern: 'www.google.com/search',
      parser: 'html',
      resultSelector: '#rso',
      fields: { title: '', url: '', snippet: '' },
      extraWaitMs: 2000,
    },
    dom: {
      waitFor: '#search',
      structural: true,
      extract: {
        container: { tag: 'DIV' },
        title: { tag: 'A' },
        link: { tag: 'A', attr: 'href' },
        snippet: { tag: 'DIV' },
      },
    },
    bans: [
      { name: 'google-captcha', signal: 'captcha', checkUrl: /\/sorry\// },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 3000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── Stack Overflow (via site:google.com — structural) ─────────────────────
  stackoverflow: {
    id: 'stackoverflow',
    name: 'Stack Overflow',
    help: 'Stack Overflow (via Google site search). Google qualifiers apply: site:, filetype:, intitle:, inurl:.',
    qualifierExamples: ['site:example.com    Search within a site (in addition to MDN/SO)', 'filetype:pdf        Filter by file type', 'intitle:hello       Title must contain'],
    url: (q) => `https://www.google.com/search?q=site%3Astackoverflow.com+${encodeURIComponent(q)}&hl=en`,
    strategies: { primary: 'dom', fallback: 'network' },
    network: {
      urlPattern: 'www.google.com/search',
      parser: 'html',
      resultSelector: '#rso',
      fields: { title: '', url: '', snippet: '' },
      extraWaitMs: 2000,
    },
    dom: {
      waitFor: '#search',
      structural: true,
      extract: {
        container: { tag: 'DIV' },
        title: { tag: 'A' },
        link: { tag: 'A', attr: 'href' },
        snippet: { tag: 'DIV' },
      },
    },
    bans: [
      { name: 'google-captcha', signal: 'captcha', checkUrl: /\/sorry\// },
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'cloudflare-captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 3000, onCaptcha: 'hitl', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' },
  },

  // ─── Fetch (arbitrary URL → markdown) ───────────────────────────────────────
  // Not a search provider: the "query" IS the URL to fetch. Renders the page in a
  // fresh COOKIELESS context (logged out), serializes the settled DOM, and returns
  // it as markdown in `content`. Zero per-site config — the general web-fetch path.
  // See search-fetch.ts / FETCH.md §2.3. The authenticated (session) tier is not
  // built yet — an anonymous fetch that hits a bot wall reports the challenge
  // rather than solving it.
  fetch: {
    id: 'fetch',
    name: 'Fetch',
    help: 'Fetch any URL and return it as markdown. The query IS the URL (e.g. `fetch https://react.dev`). Cookieless render, no per-site config. Returns markdown in `content`, not `results`.',
    qualifierExamples: [],
    url: (q) => q,
    strategies: { primary: 'fetch' },
    // Markers are STRUCTURAL (script paths, challenge tokens, widget hosts) — not
    // prose — and are only consulted when the rendered page is near-empty
    // (search-fetch.ts CHALLENGE_SPARSE_CHARS gate). A content-rich page that
    // merely mentions these words in text is never flagged.
    bans: [
      { name: 'cloudflare-challenge', signal: 'captcha', checkBody: /Just a moment\.\.\.|\/cdn-cgi\/challenge-platform\/|__cf_chl_|cf_chl_opt|window\._cf_chl|_fs-ch-|Client Challenge/i },
      { name: 'captcha-widget', signal: 'captcha', checkBody: /challenges\.cloudflare\.com\/turnstile|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i },
      { name: 'access-blocked', signal: 'banned', checkBody: /Attention Required! \| Cloudflare|Error 1020|error code: 1020|\/cdn-cgi\/error\//i },
    ],
    retry: { maxAttempts: 1, baseDelayMs: 0, onCaptcha: 'abort', onRateLimit: 'abort', onTimeout: 'abort', onBan: 'abort' },
  },
} satisfies Record<string, ProviderConfig>

/** The id of every registered provider, in registration order. */
export type ProviderName = keyof typeof PROVIDERS

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[]

/** True when `name` is a registered provider id. */
export function isProviderName(name: string): name is ProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name)
}

/** The provider registered under `name`; throws UNKNOWN_PROVIDER (StealthSearchError) otherwise. */
export function getProvider(name: string): ProviderConfig {
  if (!isProviderName(name)) {
    throw searchError('UNKNOWN_PROVIDER', `Unknown provider "${name}". Available: ${PROVIDER_NAMES.join(', ')}`, {
      detail: { provider: name, available: PROVIDER_NAMES },
    })
  }
  return PROVIDERS[name]
}
