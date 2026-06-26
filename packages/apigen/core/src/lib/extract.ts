// v2 Symbol-based extractor (SPEC §3, §4, §5).
//
// Walks a TypeScript source module via ts-morph and produces canonical
// `Operation[]` descriptors — one per exported callable or serializable-data
// binding. Unlike the v1 extractors (named.ts / default-export.ts /
// named-object.ts) which return raw `FnMeta[]`, this extractor:
//
//   - Names each operation by its **exported symbol** (fixes v1 F28/F29 bugs).
//   - Handles the full export-shape matrix (§3 / §4 / notes at bottom).
//   - Sets `safe` from `kind` default (query→true, action→false) per §4.
//   - Populates `input`/`output` JSON-Schema via the existing `buildSchema`.
//   - Attaches `typeText` (language-tagged, same-host sugar) where available.
//   - Synthesises stable `id`s for anonymous-default and CJS shapes (R13).
//
// Export-shape matrix handled:
//   1. Named function export          `export function foo(…)`
//   2. Named arrow/const export       `export const foo = (…) => …`
//   3. Named-object export            `export const api = { foo, bar }`
//   4. Default-export named fn        `export default function foo(…)`
//   5. Anonymous default export       `export default () => …` / `export default function(){}`
//   6. CJS source                     `module.exports = { foo, bar }`
//
// Invariant [inv:ctx-name-only]: the `ctx` first-param is excluded from
// generated schemas by name match only — no type inspection.
//
// `query` (serializable-data const) is served live: the descriptor carries its
// TYPE (schema), not its value (§4). Non-serializable, non-callable exports are
// skipped + warned.

import path from 'node:path'
import { Project, type SourceFile, SyntaxKind } from 'ts-morph'
import type { Operation, Segment } from './descriptor'
import { buildSchema } from './schema-builders/ts-json-schema'

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Absolute path to the TypeScript (or JavaScript) source file. */
  sourceFile: string
  /**
   * Namespace segment (from `--namespace` or tsconfig folder). Casing-neutral
   * words are derived from the raw string. Defaults to `''`.
   */
  namespace?: string
  /** Absolute path to a tsconfig.json for type resolution. Optional. */
  tsconfig?: string
}

/**
 * Walks `opts.sourceFile` and emits canonical `Operation[]` descriptors.
 *
 * Handles all six shapes in the export-shape matrix. Each operation is named
 * by the **exported symbol** in source — never by position or internal name.
 *
 * @param opts - Extraction options.
 * @returns Resolved array of canonical operations.
 */
export async function extract(opts: ExtractOptions): Promise<Operation[]> {
  const { sourceFile: filePath, namespace = '', tsconfig } = opts

  const project = tsconfig
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ skipAddingFilesFromTsConfig: true })
  const sf: SourceFile = project.addSourceFileAtPath(filePath)

  const fileName = path.basename(filePath)
  // Per SPEC §5: strip extension; dots/underscores → hyphens.
  const fileSegment = makeSeg(normalizeFileName(fileName))
  const namespaceSeg = makeSeg(namespace)

  const ops: Operation[] = []

  // The set of names a binding is exported UNDER (the exported symbols), keyed
  // by the exported symbol — NOT the declaration name. A declaration reached
  // only via `export { local as alias }` appears here under `alias`, never
  // `local`. We gate the Shape 1/2 walkers on this set so a declaration that is
  // exported only under a rename is NOT emitted under its declaration name —
  // ts-morph's `isExported()` is true for such declarations, but `getName()`
  // returns the LOCAL name, which is the F28/F29 bug. Renamed exports are
  // emitted (by their alias) in the Shape 1b block below.
  const exportedNames = new Set(sf.getExportedDeclarations().keys())

  // ── Shape 1 & 2: Named function exports + named arrow/const exports ──────
  // Delegate to the raw named extractor logic (inline here so we control sym).
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported() || fn.isDefaultExport()) continue
    const name = fn.getName() ?? ''
    if (!name) continue
    if (shouldSkip(name)) continue
    // Skip declarations exported only under a rename — emitted by alias below.
    if (!exportedNames.has(name)) continue

    const sig = fn.getSignature()
    const params = rawParams(sig)
    const returnText = sig.getReturnType().getText()

    ops.push(
      await buildActionOp(project, sf, namespaceSeg, fileSegment, name, params, returnText, fn.isAsync(), tsconfig),
    )
  }

  for (const decl of sf.getVariableDeclarations()) {
    const stmt = decl.getVariableStatement()
    if (!stmt?.isExported()) continue

    const name = decl.getName()
    if (shouldSkip(name)) continue
    // Skip declarations exported only under a rename — emitted by alias below.
    if (!exportedNames.has(name)) continue

    const init = decl.getInitializer()
    if (!init) continue
    const kindName = init.getKindName()

    if (['ArrowFunction', 'FunctionExpression'].includes(kindName)) {
      // Shape 2: named const/arrow fn
      const varType = decl.getType()
      const sigs = varType.getCallSignatures()
      if (sigs.length === 0) continue

      const sig = sigs[0]
      const params = rawParamsFromSig(sig, decl)
      const returnText = sig.getReturnType().getText()
      const isAsync = init.getKindName() === 'ArrowFunction'
        ? (init as import('ts-morph').ArrowFunction).isAsync()
        : (init as import('ts-morph').FunctionExpression).isAsync()

      ops.push(
        await buildActionOp(project, sf, namespaceSeg, fileSegment, name, params, returnText, isAsync, tsconfig),
      )
    } else if (['ObjectLiteralExpression'].includes(kindName)) {
      // Shape 3: named-object export — `export const api = { foo, bar }`
      const objType = decl.getType()
      for (const prop of objType.getProperties()) {
        const propName = prop.getName()
        if (shouldSkip(propName)) continue

        const propType = prop.getTypeAtLocation(decl)
        const sigs = propType.getCallSignatures()
        if (sigs.length === 0) continue // non-function prop — skip

        const sig = sigs[0]
        const params = rawParamsFromSig(sig, decl)
        const returnText = sig.getReturnType().getText()

        // Path: [file, objectName, propName]
        const propPath: Segment[] = [fileSegment, makeSeg(name), makeSeg(propName)]
        ops.push(await buildActionOpAtPath(project, sf, namespaceSeg, propPath, propName, params, returnText, false, tsconfig))
      }
    } else {
      // May be a serializable-data const (kind=query) — check serializability
      const constType = decl.getType()
      const typeText = constType.getText()
      if (isSerializableType(typeText)) {
        const schema = await buildSchema(project, sf, typeText, tsconfig)
        ops.push(buildQueryOp(namespaceSeg, fileSegment, name, schema))
      } else {
        // Non-serializable, non-callable — skip + warn
        console.warn(`[apigen-core] Skipping non-callable, non-serializable export: ${name}`)
      }
    }
  }

  // ── Shape 4 & 5: Default export (named fn or anonymous) ──────────────────
  const defaultSym = sf.getDefaultExportSymbol()
  if (defaultSym) {
    const exportAssign = sf.getExportAssignment(a => !a.isExportEquals())

    if (exportAssign) {
      const expr = exportAssign.getExpression()
      const exprKind = expr.getKindName()

      if (['ArrowFunction', 'FunctionExpression'].includes(exprKind)) {
        // Shape 5: anonymous default export  — synthesise stable id from filename
        const anonName = normalizeFileName(fileName).replace(/-/g, '_') + '_default'
        const fnType = expr.getType()
        const sigs = fnType.getCallSignatures()
        if (sigs.length > 0) {
          const sig = sigs[0]
          const params = rawParamsSig(sig)
          const returnText = sig.getReturnType().getText()
          const isAsync = exprKind === 'ArrowFunction'
            ? (expr as import('ts-morph').ArrowFunction).isAsync()
            : (expr as import('ts-morph').FunctionExpression).isAsync()

          // Path = [file] per SPEC §5 "single default fn → path=[file]"
          // But symbol is anonymous — we use the synthesized name as raw
          const anonSeg: Segment = { raw: anonName, words: tokenize(anonName) }
          ops.push(
            await buildActionOpAtPath(project, sf, namespaceSeg, [anonSeg], anonName, params, returnText, isAsync, tsconfig),
          )
        }
      } else {
        // Could be an object literal (default object) — treat as named-object recursion
        const objType = expr.getType()
        for (const prop of objType.getProperties()) {
          const propName = prop.getName()
          if (shouldSkip(propName)) continue
          const propType = prop.getTypeAtLocation(exportAssign)
          const sigs = propType.getCallSignatures()
          if (sigs.length === 0) continue
          const sig = sigs[0]
          const params = rawParamsSig(sig)
          const returnText = sig.getReturnType().getText()
          // SPEC §5: default object → path=[file,"default",…keys]
          const propPath: Segment[] = [fileSegment, makeSeg('default'), makeSeg(propName)]
          ops.push(await buildActionOpAtPath(project, sf, namespaceSeg, propPath, propName, params, returnText, false, tsconfig))
        }
      }
    } else {
      // Shape 4: `export default function foo(…)` — the function declaration form
      const decls = defaultSym.getDeclarations()
      for (const d of decls) {
        if (d.getKindName() !== 'FunctionDeclaration') continue
        const fnDecl = d as import('ts-morph').FunctionDeclaration
        const sym = fnDecl.getName()
        // If named, use the name; if anonymous, synthesise from filename
        const symName = sym && sym.length > 0
          ? sym
          : normalizeFileName(fileName).replace(/-/g, '_') + '_default'
        const sig = fnDecl.getSignature()
        const params = rawParams(sig)
        const returnText = sig.getReturnType().getText()
        ops.push(
          await buildActionOp(project, sf, namespaceSeg, fileSegment, symName, params, returnText, fnDecl.isAsync(), tsconfig),
        )
      }
    }
  }

  // ── Shape 1b: Renamed exports — `export { localFn as exportedName }` ─────
  // The declaration `localFn` is NOT marked `isExported()` (it's a bare local),
  // so the Shape 1/2 walkers above skip it. The export specifier carries the
  // EXPORTED symbol via its alias — that is the canonical operation name
  // (SPEC §3/§5; closes F28/F29). We resolve each renamed specifier to its local
  // callable declaration and emit an op named by the alias, never the local name.
  const seenExportNames = new Set(ops.map(o => o.path[o.path.length - 1].raw))
  for (const ed of sf.getExportDeclarations()) {
    // Skip `export … from '…'` re-exports; we only handle local renames here.
    if (ed.getModuleSpecifier()) continue
    for (const spec of ed.getNamedExports()) {
      const aliasNode = spec.getAliasNode()
      if (!aliasNode) continue // not a rename — `export { foo }` already covered
      const exportedName = aliasNode.getText()
      if (shouldSkip(exportedName)) continue
      if (seenExportNames.has(exportedName)) continue

      // Resolve the local symbol the specifier points at.
      const localSym = spec.getSymbol()?.getAliasedSymbol() ?? spec.getSymbol()
      const decls = localSym?.getDeclarations() ?? []
      for (const d of decls) {
        const kind = d.getKindName()
        if (kind === 'FunctionDeclaration') {
          const fnDecl = d as import('ts-morph').FunctionDeclaration
          const sig = fnDecl.getSignature()
          const params = rawParams(sig)
          const returnText = sig.getReturnType().getText()
          ops.push(
            await buildActionOp(project, sf, namespaceSeg, fileSegment, exportedName, params, returnText, fnDecl.isAsync(), tsconfig),
          )
          seenExportNames.add(exportedName)
          break
        }
        if (kind === 'VariableDeclaration') {
          const varDecl = d as import('ts-morph').VariableDeclaration
          const varType = varDecl.getType()
          const sigs = varType.getCallSignatures()
          if (sigs.length === 0) break // non-callable rename — skip
          const sig = sigs[0]
          const params = rawParamsFromSig(sig, varDecl)
          const returnText = sig.getReturnType().getText()
          const init = varDecl.getInitializer()
          let isAsync = false
          if (init?.getKindName() === 'ArrowFunction') {
            isAsync = (init as import('ts-morph').ArrowFunction).isAsync()
          } else if (init?.getKindName() === 'FunctionExpression') {
            isAsync = (init as import('ts-morph').FunctionExpression).isAsync()
          }
          ops.push(
            await buildActionOp(project, sf, namespaceSeg, fileSegment, exportedName, params, returnText, isAsync, tsconfig),
          )
          seenExportNames.add(exportedName)
          break
        }
      }
    }
  }

  // ── Shape 6: CJS — `module.exports = { foo, bar }` ───────────────────────
  // ts-morph exposes module.exports assignments via getStatements + kind matching.
  const cjsExports = extractCjsExports(sf)
  if (cjsExports.length > 0) {
    for (const { name: propName, sig } of cjsExports) {
      if (shouldSkip(propName)) continue
      const params = rawParamsSig(sig)
      const returnText = sig.getReturnType().getText()
      // Synthesise stable id from filename + symbol — CJS module scope
      const cjsPath: Segment[] = [fileSegment, makeSeg(propName)]
      ops.push(await buildActionOpAtPath(project, sf, namespaceSeg, cjsPath, propName, params, returnText, false, tsconfig))
    }
  }

  return ops
}

// ---------------------------------------------------------------------------
// Operation builders
// ---------------------------------------------------------------------------

type RawParam = { name: string; type: string; optional: boolean }

async function buildActionOp(
  project: Project,
  sf: SourceFile,
  ns: Segment,
  fileSeg: Segment,
  exportName: string,
  params: RawParam[],
  returnText: string,
  isAsync: boolean,
  tsconfig?: string,
): Promise<Operation> {
  const exportSeg = makeSeg(exportName)
  const opPath: Segment[] = [fileSeg, exportSeg]
  return buildActionOpAtPath(project, sf, ns, opPath, exportName, params, returnText, isAsync, tsconfig)
}

async function buildActionOpAtPath(
  project: Project,
  sf: SourceFile,
  ns: Segment,
  opPath: Segment[],
  exportName: string,
  params: RawParam[],
  returnText: string,
  isAsync: boolean,
  tsconfig?: string,
): Promise<Operation> {
  // [inv:ctx-name-only] — exclude ctx by name, no type checking
  const domainParams = params.filter(p => p.name !== 'ctx')
  const required = domainParams.filter(p => !p.optional).map(p => p.name)

  const properties: Record<string, unknown> = {}
  for (const p of domainParams) {
    properties[p.name] = await buildSchema(project, sf, p.type, tsconfig)
  }

  // Unwrap Promise<T> → T for output schema
  const resolvedReturn = returnText.replace(/^Promise<(.+)>$/, '$1').trim()
  const outputSchema = await buildSchema(project, sf, resolvedReturn, tsconfig)

  const inputSchema: Record<string, unknown> = { type: 'object', properties, required }

  const id = buildId(ns, opPath)

  return {
    id,
    host: 'ts',
    namespace: ns,
    path: opPath,
    kind: 'action',
    async: isAsync,
    streaming: false,
    safe: false, // action → false per §4
    input: inputSchema,
    output: outputSchema,
    envelope: {},
    typeText: {
      lang: 'ts',
      input: paramsToTypeText(params),
      output: resolvedReturn,
    },
  }
}

function buildQueryOp(ns: Segment, fileSeg: Segment, exportName: string, schema: Record<string, unknown>): Operation {
  const exportSeg = makeSeg(exportName)
  const opPath: Segment[] = [fileSeg, exportSeg]
  const id = buildId(ns, opPath)
  return {
    id,
    host: 'ts',
    namespace: ns,
    path: opPath,
    kind: 'query',
    async: false,
    streaming: false,
    safe: true, // query → true per §4
    input: { type: 'object', properties: {}, required: [] },
    output: schema,
    envelope: {},
    typeText: null,
  }
}

// ---------------------------------------------------------------------------
// ID derivation — pure function of namespace + path per SPEC §4
// ---------------------------------------------------------------------------

function buildId(ns: Segment, opPath: Segment[]): string {
  const allSegs: Segment[] = ns.raw ? [ns, ...opPath] : opPath
  return allSegs.map(s => s.words.join('-')).join('/')
}

// ---------------------------------------------------------------------------
// Segment & tokenisation helpers
// ---------------------------------------------------------------------------

/**
 * Tokenises a camelCase / PascalCase / kebab-case / snake_case identifier into
 * lower-cased words. Used to build casing-neutral {@link Segment} records.
 *
 * Examples:
 *   'humanizeBytes'   → ['humanize', 'bytes']
 *   'HTMLParser'      → ['html', 'parser']
 *   'my-util'         → ['my', 'util']
 *   'SOME_CONST'      → ['some', 'const']
 */
export function tokenize(raw: string): string[] {
  return (
    raw
      // Split on hyphens, underscores, or dots used as separators
      .split(/[-_.]+/)
      .flatMap(part =>
        // Then split PascalCase / camelCase transitions
        part
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
          .replace(/([a-z\d])([A-Z])/g, '$1_$2')
          .split('_')
          .filter(Boolean),
      )
      .map(w => w.toLowerCase())
      .filter(Boolean)
  )
}

function makeSeg(raw: string): Segment {
  return { raw, words: tokenize(raw) }
}

/** Normalise a file name: strip extension; dots/underscores → hyphens. */
function normalizeFileName(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, '')
  return noExt.replace(/[._]+/g, '-')
}

// ---------------------------------------------------------------------------
// CJS extraction — module.exports = { ... }
// ---------------------------------------------------------------------------

type CjsPropEntry = { name: string; sig: import('ts-morph').Signature }

function extractCjsExports(sf: SourceFile): CjsPropEntry[] {
  const result: CjsPropEntry[] = []

  // Find expression statements that are `module.exports = { ... }`
  for (const stmt of sf.getStatements()) {
    if (stmt.getKindName() !== 'ExpressionStatement') continue
    const expr = (stmt as import('ts-morph').ExpressionStatement).getExpression()
    if (expr.getKindName() !== 'BinaryExpression') continue
    const bin = expr as import('ts-morph').BinaryExpression
    // lhs must be `module.exports`
    const lhsText = bin.getLeft().getText().trim()
    if (lhsText !== 'module.exports') continue
    // operator must be `=`
    if (bin.getOperatorToken().getKindName() !== 'EqualsToken') continue

    const rhs = bin.getRight()
    const objType = rhs.getType()
    for (const prop of objType.getProperties()) {
      const propType = prop.getTypeAtLocation(rhs)
      const sigs = propType.getCallSignatures()
      if (sigs.length === 0) continue
      result.push({ name: prop.getName(), sig: sigs[0] })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Parameter extraction helpers (from ts-morph Signature / FunctionDeclaration)
// ---------------------------------------------------------------------------

function rawParams(sig: import('ts-morph').Signature): RawParam[] {
  return sig.getParameters().map(p => {
    const decls = p.getDeclarations()
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false)
    return {
      name: p.getName(),
      type: p.getTypeAtLocation(sig.getDeclaration()).getText(),
      optional,
    }
  })
}

function rawParamsFromSig(
  sig: import('ts-morph').Signature,
  locationNode: import('ts-morph').Node,
): RawParam[] {
  return sig.getParameters().map(p => {
    const decls = p.getDeclarations()
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false)
    return {
      name: p.getName(),
      type: p.getTypeAtLocation(locationNode).getText(),
      optional,
    }
  })
}

function rawParamsSig(sig: import('ts-morph').Signature): RawParam[] {
  return sig.getParameters().map(p => {
    const decls = p.getDeclarations()
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false)
    return {
      name: p.getName(),
      type: paramDecl ? paramDecl.getType().getText() : p.getValueDeclaration()?.getType()?.getText() ?? 'unknown',
      optional,
    }
  })
}

function paramsToTypeText(params: RawParam[]): string {
  const domain = params.filter(p => p.name !== 'ctx')
  if (domain.length === 0) return '()'
  return '(' + domain.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ') + ')'
}

// ---------------------------------------------------------------------------
// Skip-list — internal / non-API exports
// ---------------------------------------------------------------------------

/**
 * Returns true if the export symbol should be skipped during extraction.
 *
 * [conv:fixture-samples]: `__samples__` is a fixture-convention export that
 * must never appear as an operation. Symbols starting with `_` or `__` are
 * internal (SPEC §3 opt-out ladder, source-level).
 */
function shouldSkip(name: string): boolean {
  if (name === '__samples__') return true
  if (name.startsWith('__')) return true
  return false
}

// ---------------------------------------------------------------------------
// Serialisability heuristic for query consts
// ---------------------------------------------------------------------------

/**
 * Rough heuristic: is a type text plausibly a serialisable JSON value?
 * Primitive scalars, string literals, arrays of them, and inline object types
 * are considered serialisable. Functions, classes, and complex generics are not.
 */
function isSerializableType(typeText: string): boolean {
  const t = typeText.trim()
  // Exclude obvious non-serialisable patterns
  if (t.includes('=>')) return false
  if (t.startsWith('typeof ')) return false
  if (t.toLowerCase().includes('function')) return false
  // Primitives + common literal patterns
  if (['string', 'number', 'boolean', 'null', 'undefined'].includes(t)) return true
  if (t.startsWith("'") || t.startsWith('"')) return true // string literal
  if (/^\d/.test(t)) return true // numeric literal
  // Plain object or array
  if (t.startsWith('{') || t.startsWith('[')) return true
  if (t.endsWith('[]')) return true
  return false
}
