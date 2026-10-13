/**
 * Ticket 8468f7b1 - the public surface of the single entry point: the
 * runtime exports are pinned exactly (Object.keys of the index module), the
 * spec's types are exported, no exported name is consumer-specific
 * (`provider`, `client`) and the package has no subpath export.
 * Criteria: [tripwire-core.24] TW30.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as index from '../../index';
import type {
  ClearMethod,
  ClearOptions,
  FsPort,
  GateResult,
  JsonValue,
  Redactor,
  TripContext,
  TripInput,
  TripResult,
  Tripwire,
  TripwireOptions,
  TripwireRecord,
  TripwireSnapshot,
  TripwireStatus,
  TripwireStorage,
  TripwireWarning,
} from '../../index';

const PKG_ROOT = join(__dirname, '..', '..', '..');

describe('[tripwire-core.24] TW30 public surface', () => {
  it('Object.keys(require index) is exactly the specified runtime API', () => {
    expect(Object.keys(index).sort()).toEqual([
      'CONFIRM_TOKEN',
      'TripwireAbortedError',
      'TripwireConfirmError',
      'TripwireError',
      'TripwireIoError',
      'TripwireKeyError',
      'TripwireTrippedError',
      'adhdDataDir',
      'createFileStorage',
      'createMemoryFs',
      'createMemoryStorage',
      'createNodeFs',
      'createTripwire',
      'defaultRedactor',
      'isTripwireError',
      'isTripwireTrippedError',
    ]);
    expect(index.CONFIRM_TOKEN).toBe('I-UNDERSTAND-THE-RISK');
    for (const k of Object.keys(index) as Array<keyof typeof index>) {
      expect(index[k]).toBeDefined();
    }
  });

  it('no consumer-specific name (provider, client) is exported', () => {
    const src = readFileSync(join(PKG_ROOT, 'src', 'index.ts'), 'utf8');
    const names = [...src.matchAll(/\b([A-Za-z_$][\w$]*)\b,?\s*$/gm)]
      .map((m) => m[1]);
    for (const n of [...names, ...Object.keys(index)]) {
      expect(n).not.toMatch(/provider|client/i);
    }
  });

  it('the spec types are exported and usable', () => {
    const ctx: TripContext = {
      lastStatus: 401,
      nested: [1, 'a', null, { ok: true }],
    };
    const v: JsonValue = ctx;
    const method: ClearMethod = 'mcp-clear';
    const opts: ClearOptions = {
      method,
      reverified: true,
    };
    const status: TripwireStatus = 'unreadable';
    const redact: Redactor = (c) => c;
    const warning: TripwireWarning = {
      code: 'TRIPWIRE_IO',
      operation: 'audit.append',
      message: 'x',
    };
    const fs: FsPort = index.createMemoryFs();
    const storage: TripwireStorage = index.createMemoryStorage();
    const options: TripwireOptions = {
      namespace: 'n',
      stateDir: '/s',
      storage,
      fs,
      redact,
      onWarning: () => undefined,
    };
    const tw: Tripwire = index.createTripwire(options);
    type Shapes = [
      TripwireRecord,
      TripwireSnapshot,
      TripInput<TripContext>,
      TripResult<TripContext>,
      GateResult<TripContext>,
    ];
    const shapes: Shapes | undefined = undefined;
    expect(shapes).toBeUndefined();
    expect([v, opts, status, warning].length).toBe(4);
    expect(typeof tw.trip).toBe('function');
  });

  it('the package has no subpath export and a single CJS entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg).not.toHaveProperty('exports');
    expect(pkg).not.toHaveProperty('module');
    expect(pkg['main']).toBe('./dist/index.js');
  });
});
