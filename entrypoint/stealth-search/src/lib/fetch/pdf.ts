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

const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs'

/** How pdfjs is reached; both members are injectable so each branch is testable without loading pdfjs. */
export interface PdfjsImports {
  /** The plain dynamic import. The CommonJS emit turns it into `require()`, which loads an ES module from Node 22.12. */
  plain(): Promise<unknown>
  /** A native ESM import the compiler cannot rewrite. Only built when `plain` failed because `require(esm)` is unavailable. */
  native(specifier: string): Promise<unknown>
}

/**
 * A native dynamic `import()` built through the Function constructor, which `tsc` (module commonjs) cannot
 * rewrite into `require()`. It is eval-class, so it is the LAST resort: it is constructed only inside this
 * function, which the loader calls only after the plain import failed with `ERR_REQUIRE_ESM` or
 * `ERR_REQUIRE_ASYNC_MODULE` (Node 22.5 to 22.11, where `require(esm)` is not available). On Node 22.12 or newer
 * and under vitest the plain import succeeds and no code is ever generated from a string, so a host running with
 * `--disallow-code-generation-from-strings` or a strict CSP is unaffected there.
 * Evidence: docs/plan/stealth-browser/evidence/split/u-pdf.json (probe U-PDF, [search-port-fetch.1]).
 */
function nativeImportViaFunction(specifier: string): Promise<unknown> {
  const run = new Function('specifier', 'return import(specifier)') as (spec: string) => Promise<unknown>
  return run(specifier)
}

const DEFAULT_IMPORTS: PdfjsImports = {
  plain: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
  native: nativeImportViaFunction,
}

/** Errors meaning "this Node cannot require() that ES module", the only reason to reach for the native import. */
const REQUIRE_ESM_UNAVAILABLE = new Set(['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'])

/** Build the pdfjs loader over the given import functions. */
export function createPdfjsLoader(imports: PdfjsImports = DEFAULT_IMPORTS): PdfjsLoader {
  return async () => {
    try {
      return (await imports.plain()) as PdfjsLike
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || !REQUIRE_ESM_UNAVAILABLE.has(code)) throw cause
      return (await imports.native(PDFJS_SPECIFIER)) as PdfjsLike
    }
  }
}

const defaultLoader: PdfjsLoader = createPdfjsLoader()

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
