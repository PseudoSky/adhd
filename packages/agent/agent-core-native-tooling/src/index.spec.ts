import { describe, it, expect } from 'vitest';
import * as api from './index.js';
import {
  NATIVE_TOOL_NAMES,
  NATIVE_SERVER_CATALOG,
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  SHELL_SERVER,
  SRT_SANDBOX,
  wrapWithSandbox,
  resolveNativeTooling,
  matchPermission,
} from './index.js';

/**
 * Public-surface contract of the package barrel (what a consumer imports).
 *
 * This asserts the surface at SOURCE, so the ordinary unit run never depends on
 * a prior `build` artifact. The fact that the BUILT CJS entry loads under Node
 * (and exposes that same surface) is proven by the default-running
 * `verify-dist-load` gate, which `require()`s the real `dist/index.js`
 * (ADR-0003 / NAT-TOOL-2 AC5).
 */
describe('public surface (index barrel) — the contract a consumer imports (ADR-0008; NAT-TOOL-2 AC5)', () => {
  it('exports the resolver, the thin gate, and the native-tooling catalog', () => {
    expect(typeof resolveNativeTooling).toBe('function');
    expect(typeof matchPermission).toBe('function');
    expect(api.NATIVE_SERVER_CATALOG).toBeTypeOf('object');
    expect(NATIVE_TOOL_NAMES).toEqual(['fs', 'shell', 'dispatch']);
    expect(DISPATCH_SERVER_KEY).toBe('agent-mcp');
    expect(FS_SERVER.key).toBe('fs');
    expect(SHELL_SERVER.key).toBe('shell');
    expect(SHELL_SERVER.toolName).toBe('shell_execute');
    expect(SRT_SANDBOX.command).toBe('srt');
    expect(wrapWithSandbox({ command: 'uvx', args: ['mcp-shell-server'] })).toEqual({
      command: 'srt',
      args: ['uvx', 'mcp-shell-server'],
    });
  });
});
