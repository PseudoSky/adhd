/**
 * guards: the pypi dom config returns an empty url because findChild searches descendants while the result container is itself the anchor, or reads the description from a span when the page emits a p
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-engine.1] [audit-fixes.1]
 * The real pypi provider dom config driven over a real-shape search page (test/fixtures/providers/pypi/,
 * transcribed from the upstream warehouse template because the live page answers a plain GET with a
 * Client Challenge). The result container is the anchor.package-snippet itself, so the link lookup must
 * test the container before its descendants. Asserts url, title and description per result.
 * Ticket 8468f7b1 · [fix-search-engine.1]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { extractFromDom } from '../../../src/lib/dom.js'
import { htmlToDomTree } from '../../helpers/engine/harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', '..', 'fixtures', 'providers', 'pypi', 'search-requests.html'), 'utf8')
const pypi = getProvider('pypi')
const dom = pypi.dom
if (!dom) throw new Error('the pypi provider must carry a dom config')

describe('pypi dom config over a real-shape page [fix-search-engine.1]', () => {
  it('pypi anchor container: findChild tests the container itself so the url is the anchor href, made absolute by the urlTemplate', () => {
    const results = extractFromDom(htmlToDomTree(page), dom.extract, pypi.network?.fields?.urlTemplate)
    expect(results.map((r) => r.url)).toEqual(['https://pypi.org/project/requests/', 'https://pypi.org/project/requests-oauthlib/'])
  })

  it('pypi title and description: the name span is the title and the description is the p.package-snippet__description text', () => {
    const results = extractFromDom(htmlToDomTree(page), dom.extract, pypi.network?.fields?.urlTemplate)
    expect(results.map((r) => r.title)).toEqual(['requests', 'requests-oauthlib'])
    expect(results.map((r) => r.snippet)).toEqual(['Python HTTP for Humans.', 'OAuthlib authentication support for Requests.'])
  })

  it('pypi network selectors name the same description tag as the dom config, so both strategies read the p element', () => {
    expect(pypi.network?.fields?.snippet).toBe('p.package-snippet__description')
    expect(pypi.dom?.extract.snippet?.tag).toBe('P')
  })

  it('pypi non-result anchor: the pager link outside a package-snippet container is not a result', () => {
    const results = extractFromDom(htmlToDomTree(page), dom.extract, pypi.network?.fields?.urlTemplate)
    expect(results).toHaveLength(2)
  })

  it('P2 pypi extra: the search page carries the release date in span.package-snippet__created and no version element, so the extra is `created` and `version` is not claimed', () => {
    const results = extractFromDom(htmlToDomTree(page), dom.extract, pypi.network?.fields?.urlTemplate)
    expect(results.map((r) => r.meta)).toEqual([{ created: 'May 29, 2024' }, { created: 'Mar 22, 2024' }])
    expect(page).not.toContain('package-snippet__version')
    expect(dom.extract.extra).toEqual({ created: { tag: 'SPAN', attrs: { class: 'package-snippet__created' } } })
    expect(pypi.network?.fields?.meta).toEqual({ created: 'span.package-snippet__created' })
  })
})
