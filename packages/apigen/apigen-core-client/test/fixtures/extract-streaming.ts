// Fixture: streaming return types for extract.spec.ts (SPEC §11).
//
// Exports:
//   - streamChunks: `async function*` (AsyncGenerator<T>) — must be streaming:true,
//     output schema = the chunk type, not the AsyncGenerator wrapper.
//   - streamViaIterable: plain function returning `AsyncIterable<T>` directly
//     (no generator syntax) — must also be streaming:true.
//   - getScalar: plain `Promise<T>`-returning async function — regression
//     control, must remain streaming:false (no change in behavior).
//   - streamRecursiveChunks: `async function*` whose chunk type is
//     self-referential (`RecursiveChunk`) — per BUG-APIGEN-029 / BUG-APIGEN-
//     OUTPUT-DANGLING-REF-001 (see extract.ts's `hoistNestedDefs` doc
//     comment), a self-referential named type reliably makes
//     ts-json-schema-generator emit a `definitions`/`$defs` sibling that MUST
//     be hoisted to the output fragment's own root or its `$ref` dangles.
//     Proves the streaming path still runs through `hoistNestedDefs` exactly
//     like the non-streaming path (extract.ts unwraps `AsyncGenerator<T> → T`
//     BEFORE calling `buildSchema`, so hoisting downstream is unchanged —
//     this fixture is the regression guard for that claim).

export interface Chunk {
  n: number;
}

export interface Label {
  label: string;
}

export interface RecursiveChunk {
  value: number;
  next?: RecursiveChunk;
}

export async function* streamChunks(): AsyncGenerator<Chunk> {
  yield { n: 1 };
  yield { n: 2 };
}

export function streamViaIterable(): AsyncIterable<Label> {
  return (async function* () {
    yield { label: 'a' };
  })();
}

export async function getScalar(): Promise<{ value: string }> {
  return { value: 'ok' };
}

export async function* streamRecursiveChunks(): AsyncGenerator<RecursiveChunk> {
  yield { value: 1 };
}
