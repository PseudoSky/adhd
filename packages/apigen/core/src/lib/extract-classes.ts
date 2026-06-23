// extract-classes.ts — Class export extractor (SPEC §10).
//
// Extracts class exports from a TypeScript source module and produces canonical
// `Operation[]` descriptors:
//
//   - **Static methods** (always extracted): each static method on an exported
//     class becomes an `action` operation at `path=[file, ClassName, methodName]`.
//
//   - **Instances** (opt-in via `opts.includeInstances`):
//     - The constructor becomes a `kind:'constructor'` op at `path=[file, ClassName]`
//       (params are the ctor params, excluding any `ctx` first-param).
//     - Each public instance method becomes a `kind:'instance-method'` op at
//       `path=[file, ClassName, methodName]`.
//
// Naming: `Class.method` — the canonical `id` includes both the class segment
// and the method segment so it is globally unique (e.g. `myfile/Counter/increment`).
//
// Reuses the `buildSchema` + `tokenize` + `makeSeg` + `buildId` logic from
// extract.ts (shared helpers are imported so the same casing/id invariants hold).
//
// [inv:ctx-name-only]: ctx excluded by name, no type checking.
// [SPEC §3 opt-out ladder]: private / `_`-prefixed / non-exported class members
//   are not extracted; only `public` (or implicitly-public) instance methods are
//   included.

import path from 'node:path'
import { Project, type SourceFile, Scope } from 'ts-morph'
import type { Operation, Segment } from './descriptor'
import { buildSchema } from './schema-builders/ts-json-schema'
import { tokenize } from './extract'

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

export interface ExtractClassesOptions {
  /** Absolute path to the TypeScript (or JavaScript) source file. */
  sourceFile: string
  /**
   * Namespace segment (from `--namespace` or tsconfig folder). Casing-neutral
   * words are derived from the raw string. Defaults to `''`.
   */
  namespace?: string
  /** Absolute path to a tsconfig.json for type resolution. Optional. */
  tsconfig?: string
  /**
   * When true, extract constructor + instance-method ops in addition to static
   * method ops. Off by default (opt-in per SPEC §10).
   */
  includeInstances?: boolean
}

/**
 * Walks `opts.sourceFile` and emits canonical `Operation[]` descriptors for
 * all exported class members per SPEC §10.
 *
 * Static methods are always extracted (they are stateless function-shaped ops).
 * Constructor + instance methods require `opts.includeInstances = true`.
 *
 * @param opts - Extraction options.
 * @returns Resolved array of canonical operations (static ops + optionally
 *   constructor + instance-method ops).
 */
export async function extractClasses(opts: ExtractClassesOptions): Promise<Operation[]> {
  const { sourceFile: filePath, namespace = '', tsconfig, includeInstances = false } = opts

  const project = tsconfig
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ skipAddingFilesFromTsConfig: true })
  const sf: SourceFile = project.addSourceFileAtPath(filePath)

  const fileName = path.basename(filePath)
  const fileSegment = makeSeg(normalizeFileName(fileName))
  const namespaceSeg = makeSeg(namespace)

  const ops: Operation[] = []

  for (const cls of sf.getClasses()) {
    // Only exported classes are exposed (SPEC §3).
    if (!cls.isExported()) continue

    const className = cls.getName()
    if (!className) continue
    if (shouldSkipName(className)) continue

    const classSeg = makeSeg(className)

    // ── Static methods ─────────────────────────────────────────────────────
    for (const method of cls.getStaticMethods()) {
      const methodName = method.getName()
      if (shouldSkipName(methodName)) continue

      // Only public static methods (implicitly public when no modifier is set
      // in TS, but we also honour explicit `public`; exclude `private`/`protected`).
      const scope = method.getScope()
      if (scope === Scope.Private || scope === Scope.Protected) continue

      const sig = method.getSignature()
      const params = rawParamsFromSig(sig, method)
      const returnText = sig.getReturnType().getText()
      const isAsync = method.isAsync()

      // Path: [file, ClassName, methodName]
      const opPath: Segment[] = [fileSegment, classSeg, makeSeg(methodName)]
      ops.push(
        await buildActionOpAtPath(project, sf, namespaceSeg, opPath, params, returnText, isAsync, tsconfig),
      )
    }

    // ── Instances (opt-in) ─────────────────────────────────────────────────
    if (!includeInstances) continue

    // Constructor op: kind='constructor', path=[file, ClassName]
    {
      const ctors = cls.getConstructors()
      // Use the first declared constructor (or treat as zero-param if none).
      const ctor = ctors[0] ?? null

      let ctorParams: RawParam[] = []
      if (ctor) {
        const sig = ctor.getSignature()
        ctorParams = rawParamsFromSig(sig, ctor)
      }

      // ctor output is always `{ instanceId: string }` — the registry key.
      const ctorPath: Segment[] = [fileSegment, classSeg]
      const id = buildId(namespaceSeg, ctorPath)

      const domainParams = ctorParams.filter(p => p.name !== 'ctx')
      const required = domainParams.filter(p => !p.optional).map(p => p.name)
      const properties: Record<string, unknown> = {}
      for (const p of domainParams) {
        properties[p.name] = await buildSchema(project, sf, p.type, tsconfig)
      }

      ops.push({
        id,
        host: 'ts',
        namespace: namespaceSeg,
        path: ctorPath,
        kind: 'constructor',
        async: false,
        streaming: false,
        safe: false,
        input: { type: 'object', properties, required },
        output: {
          type: 'object',
          properties: { instanceId: { type: 'string' } },
          required: ['instanceId'],
        },
        envelope: {},
        typeText: {
          lang: 'ts',
          input: ctorParamsToTypeText(ctorParams),
          output: '{ instanceId: string }',
        },
      })
    }

    // Instance methods: kind='instance-method', path=[file, ClassName, methodName]
    for (const method of cls.getInstanceMethods()) {
      const methodName = method.getName()
      if (shouldSkipName(methodName)) continue

      const scope = method.getScope()
      if (scope === Scope.Private || scope === Scope.Protected) continue

      const sig = method.getSignature()
      const params = rawParamsFromSig(sig, method)
      const returnText = sig.getReturnType().getText()
      const isAsync = method.isAsync()

      const opPath: Segment[] = [fileSegment, classSeg, makeSeg(methodName)]
      const id = buildId(namespaceSeg, opPath)

      const domainParams = params.filter(p => p.name !== 'ctx')
      const required = domainParams.filter(p => !p.optional).map(p => p.name)
      const properties: Record<string, unknown> = {}
      for (const p of domainParams) {
        properties[p.name] = await buildSchema(project, sf, p.type, tsconfig)
      }

      // Unwrap Promise<T> → T
      const resolvedReturn = returnText.replace(/^Promise<(.+)>$/, '$1').trim()
      const outputSchema = await buildSchema(project, sf, resolvedReturn, tsconfig)

      ops.push({
        id,
        host: 'ts',
        namespace: namespaceSeg,
        path: opPath,
        kind: 'instance-method',
        async: isAsync,
        streaming: false,
        safe: false,
        input: { type: 'object', properties, required },
        output: outputSchema,
        envelope: {
          type: 'object',
          properties: { instanceId: { type: 'string' } },
          required: ['instanceId'],
        },
        typeText: {
          lang: 'ts',
          input: paramsToTypeText(params),
          output: resolvedReturn,
        },
      })
    }
  }

  return ops
}

// ---------------------------------------------------------------------------
// Operation builder (static methods — kind:'action')
// ---------------------------------------------------------------------------

type RawParam = { name: string; type: string; optional: boolean }

async function buildActionOpAtPath(
  project: Project,
  sf: SourceFile,
  ns: Segment,
  opPath: Segment[],
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
    input: { type: 'object', properties, required },
    output: outputSchema,
    envelope: {},
    typeText: {
      lang: 'ts',
      input: paramsToTypeText(params),
      output: resolvedReturn,
    },
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

function makeSeg(raw: string): Segment {
  return { raw, words: tokenize(raw) }
}

/** Normalise a file name: strip extension; dots/underscores → hyphens. */
function normalizeFileName(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, '')
  return noExt.replace(/[._]+/g, '-')
}

// ---------------------------------------------------------------------------
// Parameter extraction from ts-morph Signature / MethodDeclaration
// ---------------------------------------------------------------------------

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

function paramsToTypeText(params: RawParam[]): string {
  const domain = params.filter(p => p.name !== 'ctx')
  if (domain.length === 0) return '()'
  return '(' + domain.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ') + ')'
}

function ctorParamsToTypeText(params: RawParam[]): string {
  if (params.length === 0) return '()'
  return '(' + params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ') + ')'
}

// ---------------------------------------------------------------------------
// Skip-list — internal / non-API members
// ---------------------------------------------------------------------------

/**
 * Returns true if the class or method name should be skipped during extraction.
 *
 * Symbols starting with `_` or `__` are internal (SPEC §3 opt-out ladder,
 * source-level). `__samples__` is a fixture-convention export that must never
 * appear as an operation ([conv:fixture-samples]).
 */
function shouldSkipName(name: string): boolean {
  if (name === '__samples__') return true
  if (name.startsWith('__')) return true
  if (name.startsWith('_')) return true
  return false
}
