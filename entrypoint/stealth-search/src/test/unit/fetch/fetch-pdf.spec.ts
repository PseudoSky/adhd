/**
 * PDF text extraction through the real pdfjs on fixture bytes read in-process (inventory I-30).
 * Ticket 8468f7b1 · [search-port-fetch.4] [search-port-fetch.1]
 */
import { describe, expect, it } from 'vitest'
import { isSearchError } from '../../../errors.js'
import { extractPdfText, PDF_MAX_PAGES } from '../../../lib/fetch/pdf.js'
import { PDF_SENTENCE, readFixture } from './harness.js'

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
