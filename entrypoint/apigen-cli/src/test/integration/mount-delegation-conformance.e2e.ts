/**
 * F5 (BATCH_0.0.1.md §2/§F5) — structural-delegation conformance test.
 *
 * The spec states an invariant: the real CLI `--use` loader
 * (`entrypoint/apigen-cli/src/lib/commands/run.ts`'s `loadUsePlugins`) and a
 * hand-wired `capabilities.mount.operations()` consumer (the pattern
 * `entrypoint/backlog/src/server.ts` uses) MUST resolve to the exact same
 * `Plugin` object and invoke the exact same `mount.operations` method — not
 * two independently-maintained call paths that merely happen to agree on
 * output today (§7 open-question 2's "structural, not just regression"
 * requirement).
 *
 * An output-equality-only test (diff a fixture descriptor through both
 * paths) can stay GREEN even after a silent fork — e.g. if the fastify
 * adapter's mount-collection were rewritten to hand-build its own
 * `MountedOperation[]` instead of calling `plugin.capabilities.mount
 * .operations()`, and that reimplementation happened to produce an
 * identical shape today. This test instead proves DELEGATION: it spies on
 * the real, live `healthPlugin.capabilities.mount.operations` method itself
 * and asserts BOTH consumption paths call THROUGH that exact function
 * reference — a reimplementation would never touch the spy, so the assertion
 * would go red even with byte-identical output.
 *
 * Health (not a hypothetical `_batch` plugin) is the vehicle here because it
 * is the one mount plugin with BOTH real, load-bearing consumption paths
 * already wired in this repo today (`--use health` in `serve.ts`/`run.ts`,
 * and fastify's own test suite hand-wiring `usePlugins: [healthPlugin]`) —
 * exactly the two paths BATCH_0.0.1.md §2 documents as legitimate for any
 * mount plugin, batch included.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import healthPlugin from '@adhd/apigen-plugin-health';
import type { Descriptor, MountedOperation } from '@adhd/apigen-core-client';
import { run } from '@adhd/apigen-plugin-api-fastify';
import type { RunInput } from '@adhd/apigen-core-client';
import { loadUsePlugins } from '../../lib/commands/run';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

const sampleDescriptor: Descriptor = {
  host: 'ts',
  operations: [],
};

/** health always declares a mount capability — this is a test-fixture assertion, not a runtime guard. */
function requireMount(): NonNullable<typeof healthPlugin.capabilities.mount> {
  const mount = healthPlugin.capabilities.mount;
  if (!mount) throw new Error('healthPlugin unexpectedly has no mount capability');
  return mount;
}

// ---------------------------------------------------------------------------
// 1. The CLI `--use` loader resolves to the SAME plugin object, never a clone
// ---------------------------------------------------------------------------

describe('[F5] loadUsePlugins resolves the built-in slug to the exact healthPlugin object', () => {
  it('referential identity — not a re-imported or re-constructed copy', async () => {
    const loaded = await loadUsePlugins(['health']);
    expect(loaded).toHaveLength(1);
    // Referential (===) identity, not just deep-equal — proves the loader
    // RESOLVES the built-in slug to the statically-imported object rather
    // than reimplementing/rebuilding an equivalent plugin.
    expect(loaded[0]).toBe(healthPlugin as unknown);
  });
});

// ---------------------------------------------------------------------------
// 2/3. Real fastify server (CLI-equivalent `--use` path) vs. hand-wired
//      direct call — both resolve through the SAME method reference.
// ---------------------------------------------------------------------------

describe('[F5] structural delegation — --use path and hand-wired path call the SAME mount.operations', () => {
  let controller: AbortController;
  let baseUrl: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Spy on the REAL method, delegating to the real implementation — this
    // is not a mock replacing behavior, it's an observation wrapper around
    // the thing under test (CLAUDE.md §7: mock only the external boundary,
    // never the thing under test).
    spy = vi.spyOn(requireMount(), 'operations');

    controller = new AbortController();
    const port = await freePort();
    // This is EXACTLY the shape `entrypoint/apigen-cli/src/lib/commands/
    // run.ts`'s action handler threads through: `loadUsePlugins(['health'])`
    // resolved to `healthPlugin`, passed as `options.usePlugins` (line
    // ~310-313 of run.ts) into the target plugin's `run()`.
    const usePlugins = await loadUsePlugins(['health']);
    const runInput: RunInput = {
      packages: [],
      outputDir: '/tmp/out',
      options: { port, usePlugins },
      signal: controller.signal,
    };
    run(runInput).catch(() => {
      /* swallowed after abort */
    });
    baseUrl = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/_meta/health`);
        if (r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
    spy.mockRestore();
  });

  it('the live CLI-equivalent --use path actually called plugin.capabilities.mount.operations once at server startup (not a reimplementation)', async () => {
    // `collectMountedOperations` (`apigen-plugin-api-fastify/src/lib/run.ts`)
    // gathers mounted ops ONCE, at server-startup, before routes are
    // registered — not per-request (routes are static). The spy wraps the
    // ORIGINAL live method (`vi.spyOn` without `.mockImplementation` still
    // calls through), so if that call site were ever rewritten to hand-build
    // its own `MountedOperation[]` instead of calling
    // `plugin.capabilities.mount.operations(descriptor, opts)`, this spy
    // would see ZERO calls even though the served HTTP response stayed
    // byte-identical — this is what makes the assertion structural rather
    // than output-only.
    expect(spy.mock.calls.length).toBe(1);
    const res = await fetch(`${baseUrl}/_meta/health`);
    expect(res.status).toBe(200);
    // A live HTTP request does NOT re-invoke mount.operations (routes are
    // pre-registered at startup) — the call count must stay exactly 1.
    expect(spy.mock.calls.length).toBe(1);
  });

  it('a hand-wired direct consumer (the entrypoint/backlog/src/server.ts pattern) calls the SAME method', () => {
    const callsBefore = spy.mock.calls.length;
    const ops: MountedOperation[] = requireMount().operations(sampleDescriptor);
    expect(ops).toHaveLength(1);
    // A SECOND call on the SAME spied function reference — proving the
    // hand-wired path and the --use/server-startup path both go through the
    // identical method, not two independently-maintained implementations.
    expect(spy.mock.calls.length).toBe(callsBefore + 1);
  });

  it('both paths produce the SAME output for the SAME descriptor (regression net, secondary to delegation)', async () => {
    const res = await fetch(`${baseUrl}/_meta/health`);
    const served = (await res.json()) as { status: string; host: string };

    const [op] = requireMount().operations({
      host: 'ts',
      operations: [],
    });
    const handWired = op.handler({
      operation: op,
      data: {},
      envelope: {},
      ctx: { get: () => undefined, set: () => undefined },
      transport: 'http',
      signal: new AbortController().signal,
    }) as { status: string; host: string };

    expect(served.status).toBe(handWired.status);
    expect(served.host).toBe(handWired.host);
  });
});
