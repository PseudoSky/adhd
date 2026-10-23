/**
 * Embedded-json field rendering: `{path}` placeholders resolve against the result object, and titles and
 * snippets are cleaned (markup stripped first, entities decoded second).
 * Ticket 8468f7b1 · [core-seam.8] · commit 591e1a7 (delta report row 11).
 * Pure parser: no I/O.
 * guards: a two-placeholder title {repo.repository.owner_login}/{repo.repository.name} becomes vitejs/vite (591e1a7)
 * tier: S
 * cites: 8468f7b1 [core-seam.8]
 */
import { describe, expect, it } from 'vitest'
import { extractResultsFromEmbeddedJson } from '../../../src/lib/parsers.js'

type Capture = Parameters<typeof extractResultsFromEmbeddedJson>[1]

function page(results: unknown[]): string {
  const json = JSON.stringify({ payload: { results } })
  return `<html><script type="application/json" data-target="react-app.embeddedData">${json}</script></html>`
}

function capture(fields: Record<string, string>): Capture {
  return { resultSelector: 'payload.results', fields } as unknown as Capture
}

const one = (item: Record<string, unknown>, fields: Record<string, string>) => extractResultsFromEmbeddedJson(page([item]), capture(fields))[0]!

describe('8468f7b1 [core-seam.8] extractResultsFromEmbeddedJson renders fields (commit 591e1a7)', () => {
  it('a two-placeholder title {repo.repository.owner_login}/{repo.repository.name} becomes vitejs/vite (591e1a7)', () => {
    const r = one(
      { repo: { repository: { owner_login: 'vitejs', name: 'vite' } } },
      { title: '{repo.repository.owner_login}/{repo.repository.name}', url: 'u', snippet: 's' },
    )
    expect(r.title).toBe('vitejs/vite')
  })

  it('a missing {path} renders empty in extractResultsFromEmbeddedJson (591e1a7)', () => {
    const r = one({ repo: { repository: { owner_login: 'vitejs' } } }, { title: '{repo.repository.owner_login}/{repo.repository.name}', url: 'u', snippet: 's' })
    expect(r.title).toBe('vitejs/')
  })

  it('a plain dot-path field is unchanged and keeps its value (591e1a7)', () => {
    const r = one({ name: 'vite', link: 'https://x.test/a' }, { title: 'name', url: 'link', snippet: 'missing' })
    expect(r).toMatchObject({ title: 'vite', url: 'https://x.test/a', snippet: '' })
  })

  it('<em> highlight markup is stripped: vitejs/<em>vite</em> gives vitejs/vite (591e1a7)', () => {
    expect(one({ t: 'vitejs/<em>vite</em>' }, { title: 't', url: 'u', snippet: 's' }).title).toBe('vitejs/vite')
  })

  it('&amp; is decoded: Vite &amp; Vue gives Vite & Vue (591e1a7)', () => {
    expect(one({ t: 'Vite &amp; Vue' }, { title: 't', url: 'u', snippet: 's' }).title).toBe('Vite & Vue')
  })

  it('markup is stripped before entities decode, so a decoded <tools> survives: Vite &amp; Vue &lt;tools&gt; (591e1a7)', () => {
    expect(one({ t: 'Vite &amp; Vue &lt;tools&gt;' }, { title: 't', url: 'u', snippet: 's' }).title).toBe('Vite & Vue <tools>')
  })

  it('&quot; and &#39; are decoded in titles and snippets (591e1a7)', () => {
    const r = one({ t: 'say &quot;hi&quot;', s: 'it&#39;s <em>fine</em>' }, { title: 't', url: 'u', snippet: 's' })
    expect(r.title).toBe('say "hi"')
    expect(r.snippet).toBe("it's fine")
  })

  it('a snippet field spec also renders {path} placeholders (591e1a7)', () => {
    expect(one({ a: { b: 'x' }, c: 'y' }, { title: 't', url: 'u', snippet: '{a.b}-{c}' }).snippet).toBe('x-y')
  })
})
