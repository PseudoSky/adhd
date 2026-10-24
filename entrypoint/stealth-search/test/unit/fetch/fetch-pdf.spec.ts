/**
 * guards: PDF text extraction fails or returns wrong text for fixture bytes
 * tier: S
 * cites: ticket 8468f7b1 [search-port-fetch.4] [search-port-fetch.1] [audit-fixes.4]
 * PDF text extraction through the real pdfjs on fixture bytes read in-process (inventory [I-30]).
 * Ticket 8468f7b1 · [search-port-fetch.4] [search-port-fetch.1]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isSearchError } from '../../../src/errors.js'
import { createPdfjsLoader, extractPdfText, PDF_MAX_PAGES } from '../../../src/lib/fetch/pdf.js'
import { PDF_SENTENCE, readFixture } from '../../helpers/fetch/harness.js'

describe('pdf text extraction', () => {
  it('extracts a fixture PDF page by page', async () => {
    const bytes = new Uint8Array(readFixture('two-page.pdf'))
    const r = await extractPdfText(bytes)
    expect(r.pages).toBe(2)
    expect(r.extractedPages).toBe(2)
    expect(r.text).toContain(PDF_SENTENCE)
    expect(r.text).toContain('second page')
    expect(r.text.split('\n\n')).toHaveLength(2)
    expect(bytes.length).toBeGreaterThan(1024) // caller bytes not detached
  })

  it('honours the per-document page cap', async () => {
    expect(PDF_MAX_PAGES).toBe(100)
    const r = await extractPdfText(new Uint8Array(readFixture('two-page.pdf')), 1)
    expect(r.pages).toBe(2)
    expect(r.extractedPages).toBe(1)
    expect(r.text).toContain(PDF_SENTENCE)
    expect(r.text).not.toContain('second page')
  })

  it('a corrupt PDF raises PDF_EXTRACT_FAILED', async () => {
    const err = await extractPdfText(new Uint8Array(readFixture('corrupt.pdf'))).catch((e: unknown) => e)
    expect(isSearchError(err, 'PDF_EXTRACT_FAILED')).toBe(true)
  })

  it('a loader that cannot load pdfjs raises PDF_EXTRACT_FAILED', async () => {
    const err = await extractPdfText(new Uint8Array(1), 1, async () => {
      throw new Error('module missing')
    }).catch((e: unknown) => e)
    expect(isSearchError(err, 'PDF_EXTRACT_FAILED')).toBe(true)
  })
})

describe('[audit-fixes.4] P35 the pdfjs loader avoids code generation from strings unless require(esm) is unavailable', () => {
  const pdfjs = { getDocument: () => ({ promise: Promise.reject(new Error('unused')) }) }

  it('a plain import that works is used and the native import is never built', async () => {
    let nativeCalls = 0
    const load = createPdfjsLoader({
      plain: async () => pdfjs,
      native: async () => {
        nativeCalls++
        return pdfjs
      },
    })
    expect(await load()).toBe(pdfjs)
    expect(nativeCalls).toBe(0)
  })

  it.each(['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'])('%s from the plain import falls back to the native import with the pdfjs specifier', async (code) => {
    const asked: string[] = []
    const load = createPdfjsLoader({
      plain: async () => {
        throw Object.assign(new Error('cannot require esm'), { code })
      },
      native: async (specifier) => {
        asked.push(specifier)
        return pdfjs
      },
    })
    expect(await load()).toBe(pdfjs)
    expect(asked).toEqual(['pdfjs-dist/legacy/build/pdf.mjs'])
  })

  it('any other plain-import failure is rethrown and the native import is not tried', async () => {
    const boom = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
    let nativeCalls = 0
    const load = createPdfjsLoader({
      plain: async () => {
        throw boom
      },
      native: async () => {
        nativeCalls++
        return pdfjs
      },
    })
    await expect(load()).rejects.toBe(boom)
    expect(nativeCalls).toBe(0)
  })

  it('a failure without a code is rethrown', async () => {
    const load = createPdfjsLoader({
      plain: async () => {
        throw 'plain string'
      },
      native: async () => pdfjs,
    })
    await expect(load()).rejects.toBe('plain string')
  })

  it('the Function constructor appears only inside the lazily-called native import, never at module load', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'lib', 'fetch', 'pdf.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    const sites = code.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('new Function('))
    expect(sites).toHaveLength(1)
    const fnStart = code.findIndex((l) => l.includes('function nativeImportViaFunction'))
    expect(sites[0]?.i).toBeGreaterThan(fnStart)
    expect(sites[0]?.i).toBeLessThan(fnStart + 4)
  })
})
