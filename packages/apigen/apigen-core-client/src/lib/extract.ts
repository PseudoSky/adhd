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
//   - Synthesises stable `id`s for CJS shapes (R13); anonymous-default
//     (Shape 5) is named by the literal `'default'` — its real runtime
//     `.name` (BUG-APIGEN-033) — not a synthesized filename-derived id.
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
import { detectFormatAnnotatedAlias } from './format-alias';

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
  /**
   * When `true`, omits the file-derived path segment (normally the source
   * file's basename, e.g. `client-d` from `client.d.ts`) from every
   * operation's `path`. Default `false` (unchanged behavior — the file
   * segment disambiguates same-named exports across multiple source files
   * within one extraction run). Set this only when the source is a single,
   * stable file whose name is an extraction artifact, not a meaningful
   * namespace component (e.g. a generated `.d.ts`) — dropping it can cause
   * two same-named exports from different files to collide; the hard
   * extract-time collision guard (`@adhd/apigen-engine-naming`'s
   * `checkCollisions`) still catches that.
   */
  dropFileSegment?: boolean;
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
  const {
    sourceFile: filePath,
    namespace = '',
    dropFileSegment = false,
    tsconfig,
  } = opts;

  const project = session.projectFor(tsconfig);
  const sf: SourceFile = session.sourceFileFor(filePath, tsconfig);

  const fileName = path.basename(filePath);
  // Per SPEC §5: strip extension; dots/underscores → hyphens.
  // `fileSeg` is what actually lands in every op's `path` — `null` when the
  // caller opted out via `dropFileSegment` (see ExtractOptions doc comment).
  const fileSegment = makeSeg(normalizeFileName(fileName));
  const fileSeg: Segment | null = dropFileSegment ? null : fileSegment;
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
      const returnFormat = detectReturnFormat(sig);

      ops.push(
        await buildActionOp(
          project,
          sf,
          namespaceSeg,
          fileSeg,
          exportedName,
          params,
          returnText,
          fnDecl.isAsync(),
          tsconfig,
          session,
          returnFormat
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
      const returnFormat = detectReturnFormat(sig);
      const isAsync =
        initKind === 'ArrowFunction'
          ? (init as import('ts-morph').ArrowFunction).isAsync()
          : (init as import('ts-morph').FunctionExpression).isAsync();

      ops.push(
        await buildActionOp(
          project,
          sf,
          namespaceSeg,
          fileSeg,
          exportedName,
          params,
          returnText,
          isAsync,
          tsconfig,
          session,
          returnFormat
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
        const returnFormat = detectReturnFormat(sig);

        // Path: [file, objectName, propName] — file segment omitted when
        // `dropFileSegment` is set (see `fileSeg` above).
        const propPath: Segment[] = [
          ...(fileSeg ? [fileSeg] : []),
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
            session,
            returnFormat
          )
        );
      }
    } else {
      // May be a serializable-data const (kind=query) — check serializability
      const constType = varDecl.getType();
      const typeText = constType.getText();
      if (isSerializableType(constType, varDecl)) {
        const schema = await buildSchema(
          project,
          sf,
          typeText,
          tsconfig,
          session
        );
        ops.push(
          buildQueryOp(namespaceSeg, fileSeg, exportedName, schema)
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
        // Shape 5: anonymous default export — BUG-APIGEN-033: the op MUST be
        // named `'default'`, not a filename-derived synthetic id. ECMAScript's
        // `export default AssignmentExpression` NamedEvaluation rule gives an
        // anonymous default-exported fn/arrow a real runtime `.name` of
        // `"default"` — that's the only key `buildFnTable()`
        // (`@adhd/apigen-engine-runtime`) can ever resolve for this shape
        // (it keys every function by its live `.name`, which it cannot
        // override). Naming the op anything else here is guaranteed to be
        // unresolvable at dispatch time no matter what `buildFnTable` does.
        // `fileSeg` (via `buildActionOp`), when present, still carries the
        // per-file disambiguation in `op.path`/`id` — only the LEAF segment
        // (the actual dispatch key, `op.path[op.path.length-1].raw`) must be
        // `'default'` to match the runtime name exactly.
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
          const returnFormat = detectReturnFormat(sig);
          const isAsync =
            exprKind === 'ArrowFunction'
              ? (expr as import('ts-morph').ArrowFunction).isAsync()
              : (expr as import('ts-morph').FunctionExpression).isAsync();

          ops.push(
            await buildActionOp(
              project,
              sf,
              namespaceSeg,
              fileSeg,
              'default',
              params,
              returnText,
              isAsync,
              tsconfig,
              session,
              returnFormat
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
          const returnFormat = detectReturnFormat(sig);
          // SPEC §5: default object → path=[file,"default",…keys] (file
          // segment omitted when `dropFileSegment` is set).
          const propPath: Segment[] = [
            ...(fileSeg ? [fileSeg] : []),
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
              session,
              returnFormat
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
        // If named, use the name. If anonymous (`export default function(x){}`),
        // BUG-APIGEN-033: use the literal `'default'` — same NamedEvaluation
        // rule as the arrow/FunctionExpression Shape-5 case above gives this
        // form a real runtime `.name` of `"default"` too, and that's the only
        // key `buildFnTable()` can ever resolve it under.
        const symName = sym && sym.length > 0 ? sym : 'default';
        const sig = fnDecl.getSignature();
        // BUG-APIGEN-018: jsDocSource = fnDecl itself (analogous to Shape 1;
        // v1's extractDefault covered only the object-literal default-export
        // form, not a bare `export default function foo(…)`).
        const params = rawParams(sig, fnDecl);
        const returnText = sig.getReturnType().getText();
        const returnFormat = detectReturnFormat(sig);
        ops.push(
          await buildActionOp(
            project,
            sf,
            namespaceSeg,
            fileSeg,
            symName,
            params,
            returnText,
            fnDecl.isAsync(),
            tsconfig,
            session,
            returnFormat
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
      const returnFormat = detectReturnFormat(sig);
      // Synthesise stable id from filename + symbol — CJS module scope
      // (file segment omitted when `dropFileSegment` is set).
      const cjsPath: Segment[] = [
        ...(fileSeg ? [fileSeg] : []),
        makeSeg(propName),
      ];
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
          session,
          returnFormat
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
  /**
   * DEBT-APIGEN-007: `@format` JSDoc tag recovered from a plain, non-generic
   * reference to a user-defined scalar type alias — see
   * `detectFormatAnnotatedAlias`'s doc comment. `type` above (from
   * `Type#getText()`) has already lost the alias's identity by the time this
   * field is populated; this is a narrow side-channel that recovers just the
   * `@format` annotation without changing type-text resolution itself.
   */
  format?: string;
};

/**
 * BUG-APIGEN-029: `buildSchema()`'s Path 1 (ts-json-schema-generator) can
 * legitimately produce a `definitions`/`$defs` sibling for a self-referential
 * / recursive named type — `topRef: false` (BUG-APIGEN-026) only controls
 * whether the ENTRY type itself is `$ref`-wrapped, not a type it recursively
 * contains, which MUST stay a `$ref` + `definitions` entry (there is no other
 * way to represent a cycle in JSON Schema).
 *
 * Confirmed empirically (not merely by reading the generator's source): that
 * `definitions` sibling does NOT reliably land at the TOP of the fragment
 * `buildSchema()` hands back for the param's own type. `extract.ts`'s param
 * type-text (from the signature) and a property's type-text (from
 * `morph-walk.ts`'s `safeTypeText`, resolved relative to the property's own
 * declaration node) are frequently DIFFERENT strings for the exact same
 * TypeScript type — e.g. a fully-qualified `import("path").Foo` for the
 * top-level param vs the bare `Foo` for the same type reached again via one
 * of its own properties. Because `buildSchema`'s ancestors/deadlock guard
 * (BUG-APIGEN-CORE-003) keys purely on that literal type-text string, this
 * mismatch means the SAME type resolved through a nested property is treated
 * as an unrelated, fresh call — Path 1 can then succeed independently at that
 * NESTED position and produce its own self-contained `$ref` + `definitions`
 * pair several levels deep inside the outer fragment (verified: for a
 * self-referential `interface Foo { f?: Foo }`, `definitions` landed at
 * `<parentFragment>.properties.f.definitions`, not at the fragment's own
 * top level).
 *
 * Splicing that fragment (at whatever depth its `definitions` actually
 * landed) directly into `properties[p.name]` buries it inside the composed
 * function schema. JSON-Schema `$ref` resolution is always root-relative
 * (`#/definitions/X` resolves against the *document's own* top level, not
 * wherever `definitions` happens to be nested) — so once `composeSchemas()` /
 * `ajv.compile()` treat the whole function input as the document root, that
 * nested `definitions` sibling is invisible and the `$ref` permanently
 * dangles: `"can't resolve reference #/definitions/X from id #"` at first
 * dispatch (BUG-APIGEN-029).
 *
 * The fix walks the ENTIRE per-param fragment tree (properties, items,
 * oneOf/anyOf/allOf, additionalProperties, propertyNames, and generically any
 * other object-valued key — the same generic walk style `findDanglingRefs`
 * uses above), hoisting every `definitions`/`$defs` dict found at ANY depth
 * up to the function-level `input` schema's own root — which
 * `compose-schemas.ts` now also carries forward onto the final composed
 * document — so every `$ref` resolves no matter how deep in the fragment (or
 * the final composed schema) it originated.
 *
 * Mutates `fragment` in place (strips every hoisted `definitions`/`$defs` key
 * wherever found) and merges into `hoisted`, keyed by definitions-dict name.
 * Throws if two params in the same function contribute a same-named
 * definition with different content — that can only mean two structurally
 * different types collided under one generated name, which apigen cannot
 * safely merge.
 */
function hoistNestedDefs(
  fragment: Record<string, unknown>,
  hoisted: { definitions: Record<string, unknown>; $defs: Record<string, unknown> },
  fnName: string,
  paramName: string
): Record<string, unknown> {
  // CRITICAL: `fragment` (and every object nested inside it) may be a
  // reference SHARED with `buildSchema()`'s session/persistent cache (see
  // `buildSchema`'s own doc comment: results are memoized by reference and
  // "MUST be treated as immutable by callers"). The top-level per-param
  // fragment is already shallow-cloned by the caller (`{...built}`), but a
  // NESTED object reached via `properties`/`items`/etc. is NOT — it's the
  // exact cached object. An earlier version of this function deleted
  // `definitions`/`$defs` from nodes in place, which silently corrupted the
  // shared cache: the FIRST extraction correctly hoisted and stripped the
  // nested `definitions`, but that mutation permanently removed it from the
  // cached object too, so every SUBSEQUENT `extract()` call in the same
  // process (any later test in the same file, or a real watch/serve rebuild)
  // got back the now-definitions-less cached fragment and reintroduced the
  // exact dangling-`$ref` bug this function exists to fix — verified: running
  // two BUG-APIGEN-029 regression tests back-to-back in the same process
  // reproduced "can't resolve reference #/definitions/SelfRefParams from id
  // #" on the SECOND test only, while the first alone always passed.
  //
  // Fixed by never mutating input: this returns a freshly-cloned fragment
  // with every `definitions`/`$defs` key removed from wherever it was found,
  // and mutates only `hoisted` (the caller-owned accumulator) and its own
  // freshly-built output tree — the cache's objects are never touched.
  const stack = new Set<object>();

  const clone = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clone);
    if (!node || typeof node !== 'object') return node;
    // Defensive cycle guard: ts-json-schema-generator's output models
    // recursion via `$ref` STRINGS, never live circular JS object references,
    // so this should never actually trigger — but if it ever did, cloning
    // would otherwise stack-overflow instead of failing loudly/gracefully.
    if (stack.has(node as object)) return node;
    stack.add(node as object);
    try {
      const rec = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rec)) {
        if (key === 'definitions' || key === '$defs') {
          const defKey = key as 'definitions' | '$defs';
          const bucket = hoisted[defKey];
          for (const [defName, defValue] of Object.entries(
            value as Record<string, unknown>
          )) {
            // Recurse into the definition's OWN body too (mutually-recursive
            // types can carry a further-nested `definitions`/`$defs`) — this
            // also clones it, so the bucket never holds a cache-shared object.
            const clonedDefValue = clone(defValue);
            const existing = bucket[defName];
            if (
              existing !== undefined &&
              JSON.stringify(existing) !== JSON.stringify(clonedDefValue)
            ) {
              throw new Error(
                `[apigen-core-client] Function "${fnName}": param "${paramName}" contributes a ` +
                  `"${defKey}.${defName}" definition that conflicts with an identically-named ` +
                  `definition already hoisted from another param/output in the same function. ` +
                  `Two structurally different types share the same generated definition key, ` +
                  `so apigen cannot safely merge them into one function-level schema.`
              );
            }
            bucket[defName] = clonedDefValue;
          }
          continue; // hoisted — do not leave a copy behind in `out`
        }
        out[key] = clone(value);
      }
      return out;
    } finally {
      stack.delete(node as object);
    }
  };

  return clone(fragment) as Record<string, unknown>;
}

/**
 * DEBT-APIGEN-007: merges a recovered `@format` JSDoc annotation onto a
 * built param/output schema fragment, in place — but ONLY when it is safe
 * and unambiguous to do so:
 *   - no-op when `format` is absent (the common case — nothing recovered).
 *   - no-op when the schema already carries its own `format` (never
 *     overwrite a format ts-json-schema-generator itself already resolved,
 *     e.g. via the decimal.js nominal-detection path).
 *   - no-op when the schema is a `$ref`, or has `properties`/`items` — this
 *     annotation only ever applies to a PLAIN scalar leaf schema, never a
 *     structural/object/array/ref shape (the `detectFormatAnnotatedAlias`
 *     scalar guard already prevents the alias side from producing a format
 *     for those, but this is a second, schema-shape-level guard so a bug on
 *     one side can never silently corrupt the other).
 *   - otherwise, only actually sets `format` when `schema.type` is one of
 *     `string`/`number`/`integer`/`boolean`.
 */
function mergeFormatIfPlainScalar(
  schema: Record<string, unknown>,
  format: string | undefined
): void {
  if (!format) return;
  if (schema['format'] !== undefined) return;
  if ('$ref' in schema || 'properties' in schema || 'items' in schema) return;
  const t = schema['type'];
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') {
    schema['format'] = format;
  }
}

/**
 * DEBT-APIGEN-007: return-side counterpart of `RawParam.format` — recovers a
 * `@format` JSDoc tag from a plain, non-generic reference to a user-defined
 * scalar type alias used as a function's RETURN type, since
 * `sig.getReturnType().getText()` (the existing return-type-text resolution,
 * left unchanged) eagerly resolves the alias away exactly like the param
 * side. See `detectFormatAnnotatedAlias`'s doc comment for the full set of
 * narrow guards (non-generic, plain identifier, scalar alias only, etc).
 * Never throws — an enhancement to extraction, not a required path.
 */
function detectReturnFormat(
  sig: import('ts-morph').Signature
): string | undefined {
  try {
    return detectFormatAnnotatedAlias(sig.getDeclaration()?.getReturnTypeNode());
  } catch {
    return undefined;
  }
}

async function buildActionOp(
  project: Project,
  sf: SourceFile,
  ns: Segment,
  fileSeg: Segment | null,
  exportName: string,
  params: RawParam[],
  returnText: string,
  isAsync: boolean,
  tsconfig?: string,
  session?: InternalExtractionSession,
  returnFormat?: string
): Promise<Operation> {
  const exportSeg = makeSeg(exportName);
  const opPath: Segment[] = fileSeg ? [fileSeg, exportSeg] : [exportSeg];
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
    session,
    returnFormat
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
  session?: InternalExtractionSession,
  returnFormat?: string
): Promise<Operation> {
  // [inv:ctx-name-only] — exclude ctx by name, no type checking. Recorded via
  // `hasCtx` (BUG-APIGEN-001) so a runtime dispatcher can re-inject it as the
  // first call arg — matches the v1 generateSchemas() invariant this replaces.
  const hasCtx = params.length > 0 && params[0].name === 'ctx';
  const domainParams = params.filter((p) => p.name !== 'ctx');
  const required = domainParams.filter((p) => !p.optional).map((p) => p.name);

  const properties: Record<string, unknown> = {};
  // BUG-APIGEN-029: pooled across all domain params of this one function —
  // see hoistNestedDefs's doc comment for why this must happen.
  const hoistedDefs = {
    definitions: {} as Record<string, unknown>,
    $defs: {} as Record<string, unknown>,
  };
  for (const p of domainParams) {
    const built = await buildSchema(project, sf, p.type, tsconfig, session);
    // buildSchema's results are memoized by reference (session/persistent
    // caches) and MUST be treated as immutable by callers. `hoistNestedDefs`
    // returns a fully-cloned fragment (recursively — not just a top-level
    // shallow clone) precisely so hoisting/stripping `definitions`/`$defs`
    // and the `default`/`description` mutation below can never leak into,
    // or corrupt, the cached object shared with other params/operations.
    const propSchema = hoistNestedDefs(built, hoistedDefs, exportName, p.name);
    // BUG-APIGEN-018: surface the TS initializer / JSDoc @default as both
    // the native JSON-Schema `default` keyword and a human-readable note
    // in `description`.
    if (p.defaultValue !== undefined) {
      applyParamDefault(propSchema, p.defaultValue);
    }
    // DEBT-APIGEN-007: re-attach a `@format` JSDoc annotation recovered from
    // the param's syntactic type-alias reference (see
    // `detectFormatAnnotatedAlias`) — `propSchema` is already a fresh,
    // fully-cloned fragment (via `hoistNestedDefs`), safe to mutate here.
    mergeFormatIfPlainScalar(propSchema, p.format);
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
  // DEBT-APIGEN-007: unlike the param path above, `outputSchema` is used
  // DIRECTLY with no `hoistNestedDefs` clone — `buildSchema`'s own doc
  // comment (BUG-APIGEN-029, see above) states its results are memoized by
  // reference and MUST be treated as immutable by callers. Mutating
  // `outputSchema` in place would corrupt the shared schema cache for every
  // other operation that resolves the same return type. Only shallow-clone
  // (and only when there's actually a format to merge) — the merge itself
  // only ever touches top-level scalar keys, never anything nested.
  const finalOutputSchema = returnFormat
    ? { ...outputSchema }
    : outputSchema;
  mergeFormatIfPlainScalar(finalOutputSchema, returnFormat);

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties,
    required,
    // BUG-APIGEN-029: hoisted definitions from param fragments — see
    // hoistNestedDefs. Only attached when non-empty so the common
    // (no-recursive-type) case's schema shape is unchanged.
    ...(Object.keys(hoistedDefs.definitions).length > 0
      ? { definitions: hoistedDefs.definitions }
      : {}),
    ...(Object.keys(hoistedDefs.$defs).length > 0
      ? { $defs: hoistedDefs.$defs }
      : {}),
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
    output: finalOutputSchema,
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
  fileSeg: Segment | null,
  exportName: string,
  schema: Record<string, unknown>
): Operation {
  const exportSeg = makeSeg(exportName);
  const opPath: Segment[] = fileSeg ? [fileSeg, exportSeg] : [exportSeg];
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
      format: detectFormatAnnotatedAlias(paramDecl?.getTypeNode()),
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
      format: detectFormatAnnotatedAlias(paramDecl?.getTypeNode()),
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
      format: detectFormatAnnotatedAlias(paramDecl?.getTypeNode()),
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
// Serialisability check for query consts
// ---------------------------------------------------------------------------

/**
 * Structural check: is this compiler `Type` a plain JSON-serialisable value?
 * Inspects the actual `Type` object (properties, index signatures, call
 * signatures) rather than pattern-matching `type.getText()`'s rendering, so
 * generic wrappers around serialisable shapes -- `Record<K, V>`, `Partial<T>`,
 * `Readonly<T>`, `Array<T>` -- are recognised regardless of how the compiler
 * prints them (BUG-APIGEN-CORE-004).
 *
 * Functions, classes, and any type exposing call/construct signatures --
 * including via a nested property, e.g. `Map`/`Set`'s methods -- are rejected
 * structurally rather than by name, so `Map<K, V>` (genuinely not
 * JSON-serialisable) is correctly excluded without a deny-list entry.
 *
 * `seen` guards against infinite recursion on self-referential types (e.g. a
 * JSON-like recursive type alias); a type re-encountered mid-traversal is
 * assumed serialisable, since nothing in the traversal so far disproved it.
 */
function isSerializableType(
  type: import('ts-morph').Type,
  locationNode: import('ts-morph').Node,
  seen: Set<string> = new Set()
): boolean {
  // Functions, constructors, and class references are never serialisable.
  if (type.getCallSignatures().length > 0) return false;
  if (type.getConstructSignatures().length > 0) return false;

  if (
    type.isString() ||
    type.isNumber() ||
    type.isBoolean() ||
    type.isNull() ||
    type.isUndefined() ||
    type.isStringLiteral() ||
    type.isNumberLiteral() ||
    type.isBooleanLiteral() ||
    type.isEnumLiteral()
  ) {
    return true;
  }

  if (type.isArray() || type.isReadonlyArray()) {
    const elementType = type.getArrayElementType();
    return elementType
      ? isSerializableType(elementType, locationNode, seen)
      : false;
  }

  if (type.isTuple()) {
    return type
      .getTupleElements()
      .every((t) => isSerializableType(t, locationNode, seen));
  }

  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .every((t) => isSerializableType(t, locationNode, seen));
  }

  if (type.isIntersection()) {
    return type
      .getIntersectionTypes()
      .every((t) => isSerializableType(t, locationNode, seen));
  }

  if (type.isObject()) {
    // Cycle guard: a recursive type re-entering itself is assumed
    // serialisable (nothing in the traversal so far disproved it).
    const key = type.getText(locationNode);
    if (seen.has(key)) return true;
    seen.add(key);

    // Record<K, V> / index-signature interfaces: the value type(s) must be
    // serialisable. An indexed type has no *own* properties beyond the index
    // signature, so checking it here (short-circuiting getProperties()) is
    // sufficient.
    const stringIndexType = type.getStringIndexType();
    const numberIndexType = type.getNumberIndexType();
    if (stringIndexType || numberIndexType) {
      return [stringIndexType, numberIndexType].every(
        (t) => !t || isSerializableType(t, locationNode, seen)
      );
    }

    const properties = type.getProperties();
    if (properties.length === 0) return true; // `{}` — vacuously serialisable

    return properties.every((prop) => {
      const propType = prop.getTypeAtLocation(locationNode);
      return isSerializableType(propType, locationNode, seen);
    });
  }

  return false;
}
