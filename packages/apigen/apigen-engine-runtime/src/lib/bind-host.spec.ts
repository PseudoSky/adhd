/**
 * Listen-host default for every apigen TS host (backlog 5989ed90 S9; placeholder
 * `host-default-localhost`). Pure — binds no port (ADR-0009).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LISTEN_HOST,
  isLoopbackListenHost,
  resolveListenHost,
  warnIfNonLoopbackListen,
} from './bind-host';

describe('[host-default-localhost] resolveListenHost', () => {
  it.each([undefined, null, '', '   ', 42])('defaults to 127.0.0.1 for %j (never "all interfaces")', (v) => {
    expect(resolveListenHost(v)).toBe('127.0.0.1');
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1');
  });
  it('an explicit host override is honored verbatim (0.0.0.0 stays selectable)', () => {
    expect(resolveListenHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveListenHost(' 10.1.2.3 ')).toBe('10.1.2.3');
  });
});

describe('[host-default-localhost] warnIfNonLoopbackListen', () => {
  it('stays silent for the default and other loopback forms', () => {
    const warn = vi.fn();
    for (const h of ['127.0.0.1', 'localhost', '::1', '127.5.5.5']) {
      expect(warnIfNonLoopbackListen(h, 'apigen x host', { warn })).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns once, naming the host, for wildcard and LAN binds', () => {
    for (const h of ['0.0.0.0', '::', '192.168.0.4']) {
      const warn = vi.fn();
      expect(warnIfNonLoopbackListen(h, 'apigen x host', { warn })).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({ host: h });
      expect(warn.mock.calls[0][1]).toMatch(/non-loopback/);
    }
  });
  it('isLoopbackListenHost rejects look-alikes', () => {
    expect(isLoopbackListenHost('127.0.0')).toBe(false);
    expect(isLoopbackListenHost('::ffff:10.0.0.1')).toBe(false);
  });
});
