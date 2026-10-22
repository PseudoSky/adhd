/**
 * @adhd/stealth-search — src/lib/fetch/pdf.ts
 *
 * Text extraction from a PDF's raw bytes (inventory I-30, [search-port-fetch.1], [search-port-fetch.4]).
 *
 * Chrome renders a PDF in its pdfium viewer; the text is drawn to a canvas and is NOT in the
 * serializable DOM, so a PDF needs a real parser. pdfjs-dist's legacy Node build is ESM-only and is
 * reached through a lazy dynamic `import()` so it loads only when a PDF is fetched. Extraction
 * failure is a typed `PDF_EXTRACT_FAILED`; a PDF that parses but holds no text returns an empty
 * `text` (the caller reports `empty`).
 *
 * Ticket 8468f7b1 · plan state search-port-fetch.
 */
import { searchError } from '../../errors.js'

/** Pages extracted per document (the per-page cap). */
export const PDF_MAX_PAGES = 100

/** The extracted text and page accounting. */
export interface PdfText {
  text: string
  /** Pages in the document. */
  pages: number
  /** Pages actually read (capped at the per-document page cap). */
  extractedPages: number
}

interface PdfTextItem {
  str?: unknown
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
}
interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
/** The slice of pdfjs this module uses. */
export interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument> }
}

/** Loads pdfjs (injectable for tests). */
export type PdfjsLoader = () => Promise<PdfjsLike>

/**
 * A real dynamic `import()` that the CommonJS emit cannot rewrite. The package builds to CommonJS and
 * `tsc` turns a literal `import(x)` into `require(x)`, which cannot load the ESM-only pdfjs on the
 * supported Node floor (22.5; `require(esm)` is only unflagged from 22.12). Building the call through
 * the Function constructor keeps it a native ESM import, resolved against this module's location.
 * Evidence: docs/plan/stealth-browser/evidence/split/u-pdf.json (probe U-PDF, [search-port-fetch.1]).
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs'

const defaultLoader: PdfjsLoader = async () => {
  try {
    return (await nativeImport(PDFJS_SPECIFIER)) as PdfjsLike
  } catch (cause) {
    // A host that evaluates modules in a vm context (the vitest transform) has no import callback for
    // Function-constructor code; there the plain dynamic import is a real ESM import already.
    if ((cause as { code?: string }).code !== 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') throw cause
    return (await import(PDFJS_SPECIFIER)) as PdfjsLike
  }
}

/**
 * Extract text from PDF bytes, page by page, reading at most `maxPages` pages.
 * @throws StealthSearchError PDF_EXTRACT_FAILED when the bytes are not a readable PDF.
 */
export async function extractPdfText(bytes: Uint8Array, maxPages = PDF_MAX_PAGES, load: PdfjsLoader = defaultLoader): Promise<PdfText> {
  try {
    const pdfjs = await load()
    // pdfjs transfers/detaches the buffer it is given; hand it a copy so the caller's bytes stay intact.
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise
    const n = Math.min(doc.numPages, Math.max(1, maxPages))
    const parts: string[] = []
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const line = content.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ')
      if (line.trim()) parts.push(line.trim())
    }
    return { text: parts.join('\n\n').trim(), pages: doc.numPages, extractedPages: n }
  } catch (cause) {
    throw searchError('PDF_EXTRACT_FAILED', `could not extract text from the PDF (${cause instanceof Error ? cause.message : String(cause)})`, {
      cause,
      detail: { bytes: bytes.length },
    })
  }
}
