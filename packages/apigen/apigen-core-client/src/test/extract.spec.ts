/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `extract.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer compiles real TypeScript programs through ts-morph via extract() over on-disk fixtures (measured ~97s / 71 cases — the heaviest suite in the repo).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `extract.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: extract", () => {
  it.todo("mocked: emits an operation named by the exported symbol (getUser)");
  it.todo("mocked: emits an operation for listItems");
  it.todo("mocked: kind is action; safe defaults to false");
  it.todo("mocked: async flag is true for async function");
  it.todo("mocked: ctx param is excluded from input schema [inv:ctx-name-only]");
  it.todo("mocked: a wrong symbol name produces no matching operation");
  it.todo("mocked: emits sendEmail named by exported symbol");
  it.todo("mocked: emits computeScore");
  it.todo("mocked: optional params are not in required array");
  it.todo("mocked: a misspelled symbol name produces no match");
  it.todo("mocked: emits getUser from userApi object");
  it.todo("mocked: emits deleteUser from userApi object");
  it.todo("mocked: path includes the object name as an intermediate segment");
  it.todo("mocked: wrong property name produces no match");
  it.todo("mocked: emits processOrder named by the function symbol");
  it.todo("mocked: kind is action, host is ts");
  it.todo("mocked: id is deterministic and stable on repeated extraction");
  it.todo("mocked: wrong function name produces no match");
  it.todo("mocked: synthesises a stable id for anonymous default export");
  it.todo("mocked: synthesised id is stable across two extractions (R13)");
  it.todo("mocked: synthesised id is derived from the filename");
  it.todo("mocked: kind is action");
  it.todo("mocked: two anonymous-default extractions produce the same (not different) id");
  it.todo("mocked: emits ping named by the CJS symbol");
  it.todo("mocked: emits echo named by the CJS symbol");
  it.todo("mocked: CJS op id is stable across two extractions (R13)");
  it.todo("mocked: wrong CJS symbol name produces no match");
  it.todo("mocked: a plain re-export (`export { sourceFn } from` ...) is extracted, named by the re-exported symbol");
  it.todo("mocked: re-exported op input schema matches the direct-declaration op");
  it.todo("mocked: the LOCAL declaration name never leaks through when only re-exported");
  it.todo("mocked: `export { sourceConst as barrelConst } from` ... is named by the OUTER alias, never the local name");
  it.todo("mocked: renamed re-export input schema matches the direct-declaration op (by underlying shape)");
  it.todo("mocked: a re-exported named-object export still expands to per-property ops");
  it.todo("mocked: a two-hop chain (outer → mid → source) resolves to the terminal declaration");
  it.todo("mocked: only the OUTERMOST alias is used — intermediate-hop names never leak");
  it.todo("mocked: two-hop chain op shape matches the direct-declaration op");
  it.todo("mocked: a wildcard re-export surfaces all of the source module’s exports");
  it.todo("mocked: all ops have host=\"ts\"");
  it.todo("mocked: query consts have safe=true, action ops have safe=false");
  it.todo("mocked: all ops have non-empty id");
  it.todo("mocked: __samples__ is never emitted as an operation");
  it.todo("mocked: id is deterministic — same file always yields same ids");
  it.todo("mocked: camelCase → words");
  it.todo("mocked: PascalCase → words");
  it.todo("mocked: kebab-case → words");
  it.todo("mocked: SCREAMING_SNAKE → words");
  it.todo("mocked: includes getUser and sendEmail; excludes VERSION (non-function const)");
  it.todo("mocked: Promise<T> is unwrapped — output schema is not Promise<...>");
  it.todo("mocked: zero-param-with-ctx: listAll input properties is empty {}");
  it.todo("mocked: a TS initializer default (`strategy = \"auto\"`) becomes the JSON-Schema `default` keyword");
  it.todo("mocked: a JSDoc bracketed default (`[limit=10]`) becomes the JSON-Schema `default` keyword when there is no TS initializer");
  it.todo("mocked: a param with no default carries no `default` keyword");
  it.todo("mocked: Record<string, number> extracts as kind:\"query\" instead of being skipped");
  it.todo("mocked: Record<string, Interface> (index value is a plain data interface) extracts as kind:\"query\"");
  it.todo("mocked: Partial<T> around a serialisable shape extracts as kind:\"query\"");
  it.todo("mocked: Map<K,V> is still correctly excluded — it is a generic wrapper but genuinely not JSON-serialisable");
  it.todo("mocked: default (omitted) behavior is UNCHANGED — the file segment still leads path[0]");
  it.todo("mocked: explicit `dropFileSegment: false` is identical to omitting it");
  it.todo("mocked: `dropFileSegment: true` flattens a Shape-1 named-function op to a single-segment path");
  it.todo("mocked: `dropFileSegment: true` still keeps the object-name segment for a Shape-3 named-object op — only the FILE segment is dropped");
  it.todo("mocked: `dropFileSegment: true` flattens a Shape-6 CJS op to a single-segment path");
  it.todo("mocked: `dropFileSegment: true` flattens a kind:\"query\" op (buildQueryOp) to a single-segment path");
  it.todo("mocked: the namespace segment is unaffected — id still includes it");
  it.todo("mocked: input.properties.value carries format:\"decimal\" from the DecimalValue alias");
  it.todo("mocked: output carries format:\"decimal\" from the DecimalValue alias");
  it.todo("mocked: generic function param/return still extract exactly as before (regression guard: fix must not touch generic resolution)");
  it.todo("mocked: a self-referential chunk type (RecursiveChunk) produces an output schema whose $ref(s) resolve at the fragment root, not dangling several levels deep");
  it.todo("mocked: an `async function*` (AsyncGenerator<T>) export is streaming:true");
  it.todo("mocked: the AsyncGenerator output schema describes the per-chunk element (Chunk), not the generator wrapper");
  it.todo("mocked: a plain function returning AsyncIterable<T> directly (no generator syntax) is also streaming:true");
  it.todo("mocked: a plain Promise<T>-returning async function is unaffected — streaming:false, no regression");
});
