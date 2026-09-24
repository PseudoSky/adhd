/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `extract-classes.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer compiles real TypeScript programs through ts-morph (measured ~18s / 28 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `extract-classes.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: extract-classes", () => {
  it.todo("mocked: extracts the static \"create\" method as an action op");
  it.todo("mocked: path is [file, ClassName, methodName]");
  it.todo("mocked: id encodes file/class/method");
  it.todo("mocked: namespace is prepended to id when provided");
  it.todo("mocked: safe defaults to false (action)");
  it.todo("mocked: input schema contains constructor-param types (initialValue)");
  it.todo("mocked: _-prefixed static method is NOT extracted");
  it.todo("mocked: non-exported class produces no operations");
  it.todo("mocked: instance methods NOT extracted by default (no includeInstances)");
  it.todo("mocked: constructor op is emitted (kind:\"constructor\")");
  it.todo("mocked: constructor output schema is { instanceId: string }");
  it.todo("mocked: constructor input schema carries ctor params");
  it.todo("mocked: instance method \"increment\" is extracted (kind:\"instance-method\")");
  it.todo("mocked: instance method path is [file, ClassName, methodName]");
  it.todo("mocked: instance method envelope carries instanceId field");
  it.todo("mocked: \"getValue\" and \"reset\" are also extracted");
  it.todo("mocked: private TS method \"_log\" is NOT extracted");
  it.todo("mocked: dispose() lifecycle method is NOT extracted as an instance-method op");
  it.todo("mocked: a plainly re-exported class (`export { SourceClass } from` ...) is extracted");
  it.todo("mocked: re-exported static-method op shape matches the direct-declaration op");
  it.todo("mocked: instance methods are extracted for a re-exported class (includeInstances)");
  it.todo("mocked: `export { SourceClass as OuterClass } from` ... is path-segmented by the OUTER alias, never the local name");
  it.todo("mocked: id reflects the renamed segment (two-hop chain resolves to the terminal declaration)");
  it.todo("mocked: a wildcard-re-exported class is extracted");
  it.todo("mocked: a static async-generator method (AsyncGenerator<T>) is streaming:true");
  it.todo("mocked: an instance async-generator method (AsyncGenerator<T>) is streaming:true");
  it.todo("mocked: a plain Promise<T>-returning instance method is unaffected — streaming:false, no regression");
  it.todo("mocked: the constructor op remains streaming:false (never a stream — always {instanceId})");
});
