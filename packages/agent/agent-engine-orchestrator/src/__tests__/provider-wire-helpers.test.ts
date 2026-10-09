/**
 * c536ce29 P1-AC-B - with no `EngineConfig.wire` every wire helper is the identity on the plain
 * global, so the SDK option objects and spawn/transport behaviour are exactly what they were
 * before tracing existed. With a wire, the seam is what gets used.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

// Nothing here may start a process: the module is mocked, so `nodeSpawn` is an inert stub.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import type { WireSeams } from '../interfaces.js';
import { sdkFetchOption, wireFetch, wireSpawn, wrapMcpTransport } from '../providers/wire.js';

const transport = { start: async () => undefined, send: async () => undefined, close: async () => undefined } as Transport;

describe('c536ce29 P1-AC-B provider wire helpers', () => {
  it('c536ce29 P1-AC-B: without a wire the helpers add nothing and return the plain primitives', () => {
    for (const cfg of [undefined, {}]) {
      expect(sdkFetchOption(cfg)).toEqual({});
      expect(Object.keys(sdkFetchOption(cfg))).toHaveLength(0);
      expect(wireFetch(cfg)).toBe(globalThis.fetch);
      expect(wireSpawn(cfg)).toBe(nodeSpawn);
      expect(wrapMcpTransport(cfg, transport, { server: 's', transport: 't' })).toBe(transport);
    }
  });

  it('c536ce29 TRC-AC2: with a wire the helpers hand out exactly the injected seams', () => {
    const wrapped = { ...transport } as Transport;
    const seams: WireSeams = {
      fetch: (async () => new Response('x')) as typeof fetch,
      spawn: (() => { throw new Error('unused'); }) as unknown as typeof nodeSpawn,
      wrapTransport: (_t, meta) => Object.assign(wrapped, { meta }),
      withContext: (_c, fn) => fn(),
    };
    const cfg = { wire: seams };
    expect(sdkFetchOption(cfg)).toEqual({ fetch: seams.fetch });
    expect(wireFetch(cfg)).toBe(seams.fetch);
    expect(wireSpawn(cfg)).toBe(seams.spawn);
    expect(wrapMcpTransport(cfg, transport, { server: 'a', transport: 'stdio' })).toBe(wrapped);
  });
});
