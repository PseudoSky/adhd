import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const distEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/index.js'
);

describe('built CJS artifact (adhd ADR-0003; NAT-TOOL-2 AC5)', () => {
  it('require(dist/index.js) loads without throwing and exposes the public surface', () => {
    const mod = requireCjs(distEntry) as {
      resolveNativeTooling?: unknown;
      matchPermission?: unknown;
      NATIVE_SERVER_CATALOG?: unknown;
      NATIVE_TOOL_NAMES?: unknown;
    };
    expect(typeof mod.resolveNativeTooling).toBe('function');
    expect(typeof mod.matchPermission).toBe('function');
    expect(mod.NATIVE_SERVER_CATALOG).toBeTypeOf('object');
    expect(mod.NATIVE_TOOL_NAMES).toEqual(['fs', 'shell', 'dispatch']);
  });
});
