/**
 * c536ce29 W1-AC-A — `EngineConfig.wire` / `WireSeams` type contract. Type-level: these assertions
 * are checked by `typecheck-spec`; the runtime body only proves the shapes are usable.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { EngineConfig } from "@adhd/agent-engine-orchestrator";

import { tracedFetch, tracedSpawn, TracedTransport } from "../wire/index.js";
import { noopLogChannel } from "../wire/channels.js";

type SpawnFn = WireSeamsShape["spawn"];
type WireSeamsShape = NonNullable<EngineConfig["wire"]>;
type WireSeams = NonNullable<EngineConfig["wire"]>;

describe("c536ce29 W1-AC-A WireSeams", () => {
    it("c536ce29 W1-AC-A: wire is optional - an EngineConfig without it still typechecks", () => {
        expectTypeOf<Omit<EngineConfig, "wire">>().toMatchTypeOf<Partial<EngineConfig>>();
        expectTypeOf<EngineConfig["wire"]>().toEqualTypeOf<WireSeams | undefined>();
        expect(true).toBe(true);
    });

    it("c536ce29 W1-AC-A: the traced wrappers satisfy WireSeams", () => {
        const fakeSpawn = (() => { throw new Error("not called"); }) as unknown as SpawnFn;
        const seams: WireSeams = {
            fetch: tracedFetch(noopLogChannel()),
            spawn: tracedSpawn(noopLogChannel(), fakeSpawn),
            wrapTransport: (t, meta) => new TracedTransport(t, meta, noopLogChannel()),
            withContext: (_ctx, fn) => fn(),
        };
        expectTypeOf(seams.fetch).toEqualTypeOf<typeof fetch>();
        expectTypeOf(seams.spawn).toEqualTypeOf<SpawnFn>();
        expectTypeOf(seams.tempDir).toEqualTypeOf<string | undefined>();
        expect(seams.withContext({ a: 1 }, () => 5)).toBe(5);
    });
});
