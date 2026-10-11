/**
 * Docs contract for backlog 0ba70e47 AC4 (README documents the shell proxy
 * passthrough and its merge rule). A README that names env vars and exports
 * rots silently, so this reads the REAL README and the REAL catalog and fails
 * with the exact missing claim when they drift. No spawn, no network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_PROXY_ENV_KEYS, SHELL_SERVER } from './catalog.js';

const README = readFileSync(join(__dirname, '../../README.md'), 'utf8');
const AGENTS = readFileSync(join(__dirname, '../../AGENTS.md'), 'utf8');

describe('0ba70e47 README documents shell egress passthrough', () => {
  it('0ba70e47 AC4: README names the env var, the exports, and the exact default list', () => {
    expect(README).toContain(SHELL_SERVER.envKeys.childEnvAllowlist);
    expect(README).toContain('SHELL_PROXY_ENV_KEYS');
    expect(README).toContain('SHELL_SERVER.envKeys.childEnvAllowlist');
    expect(README).toContain(`${SHELL_SERVER.envKeys.childEnvAllowlist}=${SHELL_PROXY_ENV_KEYS.join(',')}`);
  });

  it('0ba70e47 AC4: README documents the merge rule, the sandbox:false behaviour, and ctx.env', () => {
    expect(README).toMatch(/merged, not replaced/);
    expect(README).toMatch(/entries come first/);
    expect(README).toMatch(/duplicates are removed/);
    expect(README).toMatch(/`sandbox: false` nothing is emitted/);
    expect(README).toMatch(/`ctx\.env`/);
  });

  it('0ba70e47 AC4: README documents the env-exposure note and that srt overwrites host proxy credentials', () => {
    expect(README).toMatch(/prints its environment/);
    expect(README).toMatch(/overwrites\s+any host/);
  });

  it('0ba70e47 AC4: AGENTS.md agrees (names the allowlist and the exposure)', () => {
    expect(AGENTS).toContain(SHELL_SERVER.envKeys.childEnvAllowlist);
    expect(AGENTS).toMatch(/print their env/);
  });
});
