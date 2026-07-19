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

import path from 'node:path';
import { type Project, type SourceFile } from 'ts-morph';
import type { Operation, Segment } from './descriptor';
import { buildSchema } from './schema-builders/ts-json-schema';
import {
  createExtractionSession,
  internalSession,
  type ExtractionSession,
  type InternalExtractionSession,
} from './extraction-session';
import { extractParamDefault, applyParamDefault } from './param-defaults';

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Absolute path to the TypeScript (or JavaScript) source file. */
  sourceFile: string;
  /**
   * Namespace segment (from `--namespace` or tsconfig folder). Casing-neutral
   * words are derived from the raw string. Defaults to `''`.
   */
  namespace?: string;
  /** Absolute path to a tsconfig.json for type resolution. Optional. */
  tsconfig?: string;
  /**
   * Optional per-run shared cache (see {@link createExtractionSession}).
   * When supplied, the ts-morph Project, built schema generators, and computed
   * schemas are shared with every other extraction call in the same run — and
   * released together by `session.dispose()`. When absent, a private session is
   * created and disposed before returning (previous behaviour, no retention).
   */
  session?: ExtractionSession;
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
  const ownsSession = opts.session === undefined;
  const session = internalSession(opts.session ?? createExtractionSession());
  try {
    return await extractWithSession(opts, session);
  } finally {
    if (ownsSession) session.dispose();
  }
}

async function extractWithSession(
  opts: ExtractOptions,
  session: InternalExtractionSession
): Promise<Operation[]> {
  const { sourceFile: filePath, namespace = '', tsconfig } = opts;

  const project = session.projectFor(tsconfig);
  const sf: SourceFile = session.sourceFileFor(filePath, tsconfig);

  const fileName = path.basename(filePath);
  // Per SPEC §5: strip extension; dots/underscores → hyphens.
  const fileSegment = makeSeg(normalizeFileName(fileName));
  const namespaceSeg = makeSeg(namespace);

  const ops: Operation[] = [];

  // ── Shapes 1, 2, 3 & 1b: named exports — local, renamed, AND re-exported ──
  //
  // Driven by `sf.getExportedDeclarations()` — ts-morph's own re-export-chain
  // resolver. This single declaration-driven pass replaces what used to be
  // THREE separate walks: a physical `sf.getFunctions()` walk, a physical
  // `sf.getVariableDeclarations()` walk, and a local-rename-only
  // `sf.getExportDeclarations()` walk that explicitly bailed on any specifier
  // carrying a module specifier (`if (ed.getModuleSpecifier()) continue`).
  // None of those three ever followed `export { x [as y] } from './other.js'`:
  // `getFunctions()`/`getVariableDeclarations()` only return declarations
  // PHYSICALLY located in `sf`, never ones merely re-exported into it from
  // another module — so a source file that is a pure re-export barrel (e.g. a
  // package's `index.ts`) previously extracted almost nothing.
  //
  // `getExportedDeclarations()` flattens named re-export lists, aliased
  // re-exports, multi-hop barrel chains, AND `export * from './module'`
  // wildcards down to the terminal physical declaration — keyed by the
  // OUTERMOST exported name. That is exactly the canonical-name invariant
  // this extractor already enforces for local renames (closes F28/F29 for
  // the cross-module case too): the operation is always named by the
  // exported symbol, never the internal declaration name.
  //
  // 'default' is skipped here — default exports are handled by Shape 4/5
  // below via `sf.getDefaultExportSymbol()` (which already covers both the
  // named-function-declaration and anonymous/object forms); keying off the
  // 'default' entry here too would double-extract it.
  //
  // buildSchema is deliberately called with the TOP-LEVEL entry `sf` (never
  // the resolved declaration's own source file), matching every other shape
  // in this file (4/5/6 below). Two reasons, not one:
  //   1. Correctness: ts-json-schema-generator's Path 1 (`buildSchema`'s
  //      named-type lookup) resolves a type NAME against the whole TS
  //      *program* reachable from `config.path`, not just declarations
  //      physically in that one file — and the program rooted at the entry
  //      file already transitively includes every file it re-exports from
  //      (that's how module resolution works), so a re-exported function's
  //      param/return types remain resolvable with zero extra plumbing.
  //   2. Performance: `buildSchema`'s generator cache is keyed by
  //      `(sf.getFilePath(), tsconfig)` (session.generatorCache /
  //      _generatorCache, see ts-json-schema.ts) specifically so a whole
  //      extraction run reuses ONE built TS program (see this package's
  //      BACKLOG.md PERF-APIGEN-001: "cold 37.4s → 7.4s"). An earlier version
  //      of this fix threaded each resolved declaration's OWN source file
  //      through instead — plausible-looking, but WRONG: it defeats that
  //      cache key (a distinct declSf per re-exported symbol → a distinct,
  //      NOT reused, full ts-json-schema-generator program per symbol) and
  //      OOM'd (>8GB) extracting a real ~40-file re-export barrel
  //      (sox-ecosystem's memory-core/src/index.ts) that previously (bug #1)
  //      never got far enough to build more than one program at all.
  for (const [exportedName, decls] of sf.getExportedDeclarations()) {
    if (exportedName === 'default') continue;
    if (shouldSkip(exportedName)) continue;

    // Multiple declarations can back one exported name (e.g. overload
    // signatures). Prefer a FunctionDeclaration WITH a body (the
    // implementation) over signature-only overload nodes — matches the
    // pre-existing `sf.getFunctions()` semantics, which likewise surfaced
    // only the implementation node for an overloaded function.
    const fnDecl = pickFunctionDeclWithBody(decls);
    if (fnDecl) {
      // Shape 1 / 1b: named function export (local, renamed, or re-exported).
      const sig = fnDecl.getSignature();
      // BUG-APIGEN-018: jsDocSource = fnDecl itself (matches v1 named.ts).
      const params = rawParams(sig, fnDecl);
      const returnText = sig.getReturnType().getText();

      ops.push(
        await buildActionOp(
          project,
          sf,
          namespaceSeg,
          fileSegment,
          exportedName,
          params,
          returnText,
          fnDecl.isAsync(),
          tsconfig,
          session
        )
      );
      continue;
    }

    const varDecl = decls.find(
      (d): d is import('ts-morph').VariableDeclaration =>
        d.getKindName() === 'VariableDeclaration'
    );
    // No FunctionDeclaration and no VariableDeclaration backs this exported
    // name: it's either a ClassDeclaration (handled separately by
    // extract-classes.ts, SPEC §10) or a non-callable, non-const export kind
    // (interface / type-alias / enum / namespace / …) — never extracted,
    // matching pre-existing behaviour.
    if (!varDecl) continue;

    const init = varDecl.getInitializer();
    const initKind = init?.getKindName();

    if (init && ['ArrowFunction', 'FunctionExpression'].includes(initKind ?? '')) {
      // Shape 2: named const/arrow fn (local, renamed, or re-exported).
      const varType = varDecl.getType();
      const sigs = varType.getCallSignatures();
      if (sigs.length === 0) continue;

      const sig = sigs[0];
      // BUG-APIGEN-018: jsDocSource = the enclosing VariableStatement
      // (matches v1 named.ts's const/arrow branch).
      const params = rawParamsFromSig(
        sig,
        varDecl,
        varDecl.getVariableStatement()
      );
      const returnText = sig.getReturnType().getText();
      const isAsync =
        initKind === 'ArrowFunction'
          ? (init as import('ts-morph').ArrowFunction).isAsync()
          : (init as import('ts-morph').FunctionExpression).isAsync();

      ops.push(
        await buildActionOp(
          project,
          sf,
          namespaceSeg,
          fileSegment,
          exportedName,
          params,
          returnText,
          isAsync,
          tsconfig,
          session
        )
      );
    } else if (initKind === 'ObjectLiteralExpression') {
      // Shape 3: named-object export — `export const api = { foo, bar }`
      // (local, renamed, or re-exported).
      const objType = varDecl.getType();
      for (const prop of objType.getProperties()) {
        const propName = prop.getName();
        if (shouldSkip(propName)) continue;

        const propType = prop.getTypeAtLocation(varDecl);
        const sigs = propType.getCallSignatures();
        if (sigs.length === 0) continue; // non-function prop — skip

        const sig = sigs[0];
        // BUG-APIGEN-018: jsDocSource = the enclosing VariableStatement
        // (matches v1 named-object.ts).
        const params = rawParamsFromSig(
          sig,
          varDecl,
          varDecl.getVariableStatement()
        );
        const returnText = sig.getReturnType().getText();

        // Path: [file, objectName, propName]
        const propPath: Segment[] = [
          fileSegment,
          makeSeg(exportedName),
          makeSeg(propName),
        ];
        ops.push(
          await buildActionOpAtPath(
            project,
            sf,
            namespaceSeg,
            propPath,
            propName,
            params,
            returnText,
            false,
            tsconfig,
            session
          )
        );
      }
    } else {
      // May be a serializable-data const (kind=query) — check serializability
      const constType = varDecl.getType();
      const typeText = constType.getText();
      if (isSerializableType(typeText)) {
        const schema = await buildSchema(
          project,
          sf,
          typeText,
          tsconfig,
          session
        );
        ops.push(
          buildQueryOp(namespaceSeg, fileSegment, exportedName, schema)
        );
      } else {
        // Non-serializable, non-callable — skip + warn
        console.warn(
          `[apigen-core] Skipping non-callable, non-serializable export: ${exportedName}`
        );
      }
    }
  }

  // ── Shape 4 & 5: Default export (named fn or anonymous) ──────────────────
  const defaultSym = sf.getDefaultExportSymbol();
  if (defaultSym) {
    const exportAssign = sf.getExportAssignment((a) => !a.isExportEquals());

    if (exportAssign) {
      const expr = exportAssign.getExpression();
      const exprKind = expr.getKindName();

      if (['ArrowFunction', 'FunctionExpression'].includes(exprKind)) {
        // Shape 5: anonymous default export  — synthesise stable id from filename
        const anonName =
          normalizeFileName(fileName).replace(/-/g, '_') + '_default';
        const fnType = expr.getType();
        const sigs = fnType.getCallSignatures();
        if (sigs.length > 0) {
          const sig = sigs[0];
          // BUG-APIGEN-018: jsDocSource = the export assignment statement
          // (closest carrier of a leading JSDoc block; v1 had no equivalent
          // shape — anonymous default export params were never covered by
          // v1's object-literal-only `extractDefault`).
          const params = rawParamsSig(sig, exportAssign);
          const returnText = sig.getReturnType().getText();
          const isAsync =
            exprKind === 'ArrowFunction'
              ? (expr as import('ts-morph').ArrowFunction).isAsync()
              : (expr as import('ts-morph').FunctionExpression).isAsync();

          // Path = [file] per SPEC §5 "single default fn → path=[file]"
          // But symbol is anonymous — we use the synthesized name as raw
          const anonSeg: Segment = { raw: anonName, words: tokenize(anonName) };
          ops.push(
            await buildActionOpAtPath(
              project,
              sf,
              namespaceSeg,
              [anonSeg],
              anonName,
              params,
              returnText,
              isAsync,
              tsconfig,
              session
            )
          );
        }
      } else {
        // Could be an object literal (default object) — treat as named-object recursion
        const objType = expr.getType();
        for (const prop of objType.getProperties()) {
          const propName = prop.getName();
          if (shouldSkip(propName)) continue;
          const propType = prop.getTypeAtLocation(exportAssign);
          const sigs = propType.getCallSignatures();
          if (sigs.length === 0) continue;
          const sig = sigs[0];
          // BUG-APIGEN-018: jsDocSource = exportAssign (matches v1
          // default-export.ts's object-property branch).
          const params = rawParamsSig(sig, exportAssign);
          const returnText = sig.getReturnType().getText();
          // SPEC §5: default object → path=[file,"default",…keys]
          const propPath: Segment[] = [
            fileSegment,
            makeSeg('default'),
            makeSeg(propName),
          ];
          ops.push(
            await buildActionOpAtPath(
              project,
              sf,
              namespaceSeg,
              propPath,
              propName,
              params,
              returnText,
              false,
              tsconfig,
              session
            )
          );
        }
      }
    } else {
      // Shape 4: `export default function foo(…)` — the function declaration form
      const decls = defaultSym.getDeclarations();
      for (const d of decls) {
        if (d.getKindName() !== 'FunctionDeclaration') continue;
        const fnDecl = d as import('ts-morph').FunctionDeclaration;
        const sym = fnDecl.getName();
        // If named, use the name; if anonymous, synthesise from filename
        const symName =
          sym && sym.length > 0
            ? sym
            : normalizeFileName(fileName).replace(/-/g, '_') + '_default';
        const sig = fnDecl.getSignature();
        // BUG-APIGEN-018: jsDocSource = fnDecl itself (analogous to Shape 1;
        // v1's extractDefault covered only the object-literal default-export
        // form, not a bare `export default function foo(…)`).
        const params = rawParams(sig, fnDecl);
        const returnText = sig.getReturnType().getText();
        ops.push(
          await buildActionOp(
            project,
            sf,
            namespaceSeg,
            fileSegment,
            symName,
            params,
            returnText,
            fnDecl.isAsync(),
            tsconfig,
            session
          )
        );
      }
    }
  }

  // Shape 1b (renamed exports, local or re-exported) is now folded into the
  // unified `getExportedDeclarations()` walk above — see its header comment.

  // ── Shape 6: CJS — `module.exports = { foo, bar }` ───────────────────────
  // ts-morph exposes module.exports assignments via getStatements + kind matching.
  const cjsExports = extractCjsExports(sf);
  if (cjsExports.length > 0) {
    for (const { name: propName, sig } of cjsExports) {
      if (shouldSkip(propName)) continue;
      const params = rawParamsSig(sig);
      const returnText = sig.getReturnType().getText();
      // Synthesise stable id from filename + symbol — CJS module scope
      const cjsPath: Segment[] = [fileSegment, makeSeg(propName)];
      ops.push(
        await buildActionOpAtPath(
          project,
          sf,
          namespaceSeg,
          cjsPath,
          propName,
          params,
          returnText,
          false,
          tsconfig,
          session
        )
      );
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Operation builders
// ---------------------------------------------------------------------------

type RawParam = {
  name: string;
  type: string;
  optional: boolean;
  /** BUG-APIGEN-018: raw source text of the param's default value, if any. */
  defaultValue?: string;
};

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
  session?: InternalExtractionSession
): Promise<Operation> {
  const exportSeg = makeSeg(exportName);
  const opPath: Segment[] = [fileSeg, exportSeg];
  return buildActionOpAtPath(
    project,
    sf,
    ns,
    opPath,
    exportName,
    params,
    returnText,
    isAsync,
    tsconfig,
    session
  );
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
  session?: InternalExtractionSession
): Promise<Operation> {
  // [inv:ctx-name-only] — exclude ctx by name, no type checking. Recorded via
  // `hasCtx` (BUG-APIGEN-001) so a runtime dispatcher can re-inject it as the
  // first call arg — matches the v1 generateSchemas() invariant this replaces.
  const hasCtx = params.length > 0 && params[0].name === 'ctx';
  const domainParams = params.filter((p) => p.name !== 'ctx');
  const required = domainParams.filter((p) => !p.optional).map((p) => p.name);

  const properties: Record<string, unknown> = {};
  for (const p of domainParams) {
    const built = await buildSchema(project, sf, p.type, tsconfig, session);
    // buildSchema's results are memoized by reference (session/persistent
    // caches) and MUST be treated as immutable by callers — shallow-clone
    // before mutating so per-param `default`/`description` never leaks
    // across other params or operations sharing the same type text.
    const propSchema: Record<string, unknown> = { ...built };
    // BUG-APIGEN-018: surface the TS initializer / JSDoc @default as both
    // the native JSON-Schema `default` keyword and a human-readable note
    // in `description`.
    if (p.defaultValue !== undefined) {
      applyParamDefault(propSchema, p.defaultValue);
    }
    properties[p.name] = propSchema;
  }

  // Unwrap Promise<T> → T for output schema
  const resolvedReturn = returnText.replace(/^Promise<(.+)>$/, '$1').trim();
  const outputSchema = await buildSchema(
    project,
    sf,
    resolvedReturn,
    tsconfig,
    session
  );

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties,
    required,
  };

  const id = buildId(ns, opPath);

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
    ...(hasCtx ? { hasCtx: true } : {}),
  };
}

function buildQueryOp(
  ns: Segment,
  fileSeg: Segment,
  exportName: string,
  schema: Record<string, unknown>
): Operation {
  const exportSeg = makeSeg(exportName);
  const opPath: Segment[] = [fileSeg, exportSeg];
  const id = buildId(ns, opPath);
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
  };
}

// ---------------------------------------------------------------------------
// ID derivation — pure function of namespace + path per SPEC §4
// ---------------------------------------------------------------------------

function buildId(ns: Segment, opPath: Segment[]): string {
  const allSegs: Segment[] = ns.raw ? [ns, ...opPath] : opPath;
  return allSegs.map((s) => s.words.join('-')).join('/');
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
      .flatMap((part) =>
        // Then split PascalCase / camelCase transitions
        part
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
          .replace(/([a-z\d])([A-Z])/g, '$1_$2')
          .split('_')
          .filter(Boolean)
      )
      .map((w) => w.toLowerCase())
      .filter(Boolean)
  );
}

function makeSeg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/** Normalise a file name: strip extension; dots/underscores → hyphens. */
function normalizeFileName(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, '');
  return noExt.replace(/[._]+/g, '-');
}

// ---------------------------------------------------------------------------
// CJS extraction — module.exports = { ... }
// ---------------------------------------------------------------------------

type CjsPropEntry = { name: string; sig: import('ts-morph').Signature };

function extractCjsExports(sf: SourceFile): CjsPropEntry[] {
  const result: CjsPropEntry[] = [];

  // Find expression statements that are `module.exports = { ... }`
  for (const stmt of sf.getStatements()) {
    if (stmt.getKindName() !== 'ExpressionStatement') continue;
    const expr = (
      stmt as import('ts-morph').ExpressionStatement
    ).getExpression();
    if (expr.getKindName() !== 'BinaryExpression') continue;
    const bin = expr as import('ts-morph').BinaryExpression;
    // lhs must be `module.exports`
    const lhsText = bin.getLeft().getText().trim();
    if (lhsText !== 'module.exports') continue;
    // operator must be `=`
    if (bin.getOperatorToken().getKindName() !== 'EqualsToken') continue;

    const rhs = bin.getRight();
    const objType = rhs.getType();
    for (const prop of objType.getProperties()) {
      const propType = prop.getTypeAtLocation(rhs);
      const sigs = propType.getCallSignatures();
      if (sigs.length === 0) continue;
      result.push({ name: prop.getName(), sig: sigs[0] });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exported-declarations dispatch helper
// ---------------------------------------------------------------------------

/**
 * Given the set of physical declarations backing one exported name (as
 * returned by `sf.getExportedDeclarations()`), pick the `FunctionDeclaration`
 * to extract from — preferring the one WITH a body (the implementation) over
 * signature-only overload nodes, since only the implementation node yields a
 * meaningful merged signature. Falls back to the first `FunctionDeclaration`
 * found if none has a body (e.g. an ambient `declare function` — rare, but
 * safer than returning nothing). Returns `undefined` if no declaration in the
 * set is a `FunctionDeclaration` at all.
 */
function pickFunctionDeclWithBody(
  decls: readonly import('ts-morph').ExportedDeclarations[]
): import('ts-morph').FunctionDeclaration | undefined {
  let first: import('ts-morph').FunctionDeclaration | undefined;
  for (const d of decls) {
    if (d.getKindName() !== 'FunctionDeclaration') continue;
    const fn = d as import('ts-morph').FunctionDeclaration;
    if (!first) first = fn;
    if (fn.getBody()) return fn;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Parameter extraction helpers (from ts-morph Signature / FunctionDeclaration)
// ---------------------------------------------------------------------------

function rawParams(
  sig: import('ts-morph').Signature,
  jsDocSource?: import('ts-morph').Node | null
): RawParam[] {
  return sig.getParameters().map((p) => {
    const decls = p.getDeclarations();
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null;
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false);
    return {
      name: p.getName(),
      type: p.getTypeAtLocation(sig.getDeclaration()).getText(),
      optional,
      defaultValue: extractParamDefault(paramDecl, p.getName(), jsDocSource),
    };
  });
}

function rawParamsFromSig(
  sig: import('ts-morph').Signature,
  locationNode: import('ts-morph').Node,
  jsDocSource?: import('ts-morph').Node | null
): RawParam[] {
  return sig.getParameters().map((p) => {
    const decls = p.getDeclarations();
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null;
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false);
    return {
      name: p.getName(),
      type: p.getTypeAtLocation(locationNode).getText(),
      optional,
      defaultValue: extractParamDefault(
        paramDecl,
        p.getName(),
        jsDocSource ?? locationNode
      ),
    };
  });
}

function rawParamsSig(
  sig: import('ts-morph').Signature,
  jsDocSource?: import('ts-morph').Node | null
): RawParam[] {
  return sig.getParameters().map((p) => {
    const decls = p.getDeclarations();
    const paramDecl =
      decls.length > 0 && decls[0].getKindName() === 'Parameter'
        ? (decls[0] as import('ts-morph').ParameterDeclaration)
        : null;
    const optional =
      p.isOptional() ||
      (paramDecl?.hasInitializer() ?? false) ||
      (paramDecl?.hasQuestionToken?.() ?? false);
    return {
      name: p.getName(),
      type: paramDecl
        ? paramDecl.getType().getText()
        : p.getValueDeclaration()?.getType()?.getText() ?? 'unknown',
      optional,
      defaultValue: extractParamDefault(paramDecl, p.getName(), jsDocSource),
    };
  });
}

function paramsToTypeText(params: RawParam[]): string {
  const domain = params.filter((p) => p.name !== 'ctx');
  if (domain.length === 0) return '()';
  return (
    '(' +
    domain
      .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
      .join(', ') +
    ')'
  );
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
  if (name === '__samples__') return true;
  if (name.startsWith('__')) return true;
  return false;
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
  const t = typeText.trim();
  // Exclude obvious non-serialisable patterns
  if (t.includes('=>')) return false;
  if (t.startsWith('typeof ')) return false;
  if (t.toLowerCase().includes('function')) return false;
  // Primitives + common literal patterns
  if (['string', 'number', 'boolean', 'null', 'undefined'].includes(t))
    return true;
  if (t.startsWith("'") || t.startsWith('"')) return true; // string literal
  if (/^\d/.test(t)) return true; // numeric literal
  // Plain object or array
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (t.endsWith('[]')) return true;
  return false;
}
