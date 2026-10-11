import { describe, expect, it } from 'vitest';

import {
  MAX_LISTED_ALLOWED_COMMANDS,
  augmentAllowlistDenial,
  shellAllowlistOf,
} from '../engine/denial-message.js';

/** P4b: shell allowlist denial guidance (commit 8dc52aa7, scoped to the enforcing server by 099524a8). */
describe('P4b denial-message', () => {
  const denial = 'Command not allowed: sed';

  describe('shellAllowlistOf', () => {
    it('P4b AC-allowlist: reads ALLOW_COMMANDS from the named server env, trimmed and de-duplicated', () => {
      const servers = { shell: { env: { ALLOW_COMMANDS: ' ls, cat ,ls,,rg ' } } };
      expect(shellAllowlistOf(servers, 'shell')).toEqual({ commands: ['ls', 'cat', 'rg'], hasPatterns: false });
    });

    it('P4b AC-allowlist: reports hasPatterns only for a non-blank ALLOW_PATTERNS', () => {
      const mk = (p: string | undefined) => ({ shell: { env: { ALLOW_COMMANDS: 'ls', ALLOW_PATTERNS: p } } });
      expect(shellAllowlistOf(mk('^git '), 'shell')?.hasPatterns).toBe(true);
      expect(shellAllowlistOf(mk('   '), 'shell')?.hasPatterns).toBe(false);
      expect(shellAllowlistOf(mk(undefined), 'shell')?.hasPatterns).toBe(false);
    });

    it('P4b AC-scope: only the enforcing server counts; another server allowlist is never borrowed', () => {
      const servers = {
        shell: { env: { ALLOW_COMMANDS: 'ls' } },
        other: { env: { ALLOW_COMMANDS: 'curl,wget' } },
      };
      expect(shellAllowlistOf(servers, 'shell')?.commands).toEqual(['ls']);
      expect(shellAllowlistOf(servers, 'missing')).toBeUndefined();
    });

    it('P4b AC-allowlist: undefined for no servers, no env, non-string or empty ALLOW_COMMANDS', () => {
      expect(shellAllowlistOf(undefined, 'shell')).toBeUndefined();
      expect(shellAllowlistOf({ shell: {} }, 'shell')).toBeUndefined();
      expect(shellAllowlistOf({ shell: { env: {} } }, 'shell')).toBeUndefined();
      expect(shellAllowlistOf({ shell: { env: { ALLOW_COMMANDS: 3 } } }, 'shell')).toBeUndefined();
      expect(shellAllowlistOf({ shell: { env: { ALLOW_COMMANDS: ' , ,' } } }, 'shell')).toBeUndefined();
    });
  });

  describe('augmentAllowlistDenial', () => {
    it('P4b AC-text: returns the message unchanged when no allowlist is known', () => {
      expect(augmentAllowlistDenial(denial, undefined)).toBe(denial);
      expect(augmentAllowlistDenial(denial, { commands: [], hasPatterns: false })).toBe(denial);
    });

    it('P4b AC-text: appends the allowed commands and the argv-only rule, keeping the original first', () => {
      const out = augmentAllowlistDenial(denial, { commands: ['ls', 'cat'], hasPatterns: false });
      expect(out.startsWith(`${denial}\n`)).toBe(true);
      expect(out).toContain('Allowed commands: ls, cat.');
      expect(out).toContain('Pipes, redirects and shell operators (|, >, <, &&, ;) are not supported');
      expect(out).not.toContain('allow patterns');
    });

    it('P4b AC-text: marks the list non-exhaustive when allow patterns also apply', () => {
      const out = augmentAllowlistDenial(denial, { commands: ['ls'], hasPatterns: true });
      expect(out).toContain('Allowed commands: ls (plus commands matching the configured allow patterns).');
    });

    it('P4b AC-text: elides a list longer than the cap and states how many were dropped', () => {
      const commands = Array.from({ length: MAX_LISTED_ALLOWED_COMMANDS + 7 }, (_, i) => `c${i}`);
      const out = augmentAllowlistDenial(denial, { commands, hasPatterns: false });
      expect(out).toContain(`c${MAX_LISTED_ALLOWED_COMMANDS - 1}`);
      expect(out).not.toContain(`c${MAX_LISTED_ALLOWED_COMMANDS},`);
      expect(out).toContain('... (+7 more)');
    });

    it('P4b AC-text: a list exactly at the cap is not elided', () => {
      const commands = Array.from({ length: MAX_LISTED_ALLOWED_COMMANDS }, (_, i) => `c${i}`);
      expect(augmentAllowlistDenial(denial, { commands, hasPatterns: false })).not.toContain('more)');
    });

    it('P4b AC-roundtrip: shellAllowlistOf output feeds augmentAllowlistDenial end to end', () => {
      const al = shellAllowlistOf({ shell: { env: { ALLOW_COMMANDS: 'make,rg' } } }, 'shell');
      expect(augmentAllowlistDenial(denial, al)).toContain('Allowed commands: make, rg.');
    });
  });
});
