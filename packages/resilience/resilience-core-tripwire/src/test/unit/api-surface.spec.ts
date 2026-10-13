/**
 * Ticket 8468f7b1 - the public surface of the single entry point: the
 * runtime exports are pinned exactly (Object.keys of the index module), the
 * spec's types are exported, no exported name is consumer-specific
 * (`provider`, `client`) and the package has no subpath export. The
 * interactive and CLI surface (interactiveGate, confirmSolved,
 * runUnlockCli, renderStatusText, statusJsonLine, nodeTripwireIo) and its
 * option and io types close the section-3 list.
 * Criteria: [tripwire-core.24] TW30, [tripwire-interactive.8] TW30 TW31.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as index from '../../index';
import type {
  ClearMethod,
  ClearOptions,
  ConfirmSolvedOptions,
  HitlInfo,
  InteractiveGateOptions,
  NodeTripwireIoOptions,
  TripwireIo,
  UnlockCliOptions,
  UnlockExitCode,
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
      'confirmSolved',
      'createFileStorage',
      'createMemoryFs',
      'createMemoryStorage',
      'createNodeFs',
      'createTripwire',
      'defaultRedactor',
      'interactiveGate',
      'isTripwireError',
      'isTripwireTrippedError',
      'nodeTripwireIo',
      'renderStatusText',
      'runUnlockCli',
      'statusJsonLine',
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

  it('[tripwire-interactive.8] the interactive surface is exported and ' +
    'typed', async () => {
    for (const fn of [
      index.interactiveGate,
      index.confirmSolved,
      index.runUnlockCli,
      index.renderStatusText,
      index.statusJsonLine,
      index.nodeTripwireIo,
    ]) {
      expect(typeof fn).toBe('function');
    }
    const io: TripwireIo = {
      isTTY: false,
      env: {},
      question: () => Promise.resolve(null),
      out: () => undefined,
      err: () => undefined,
    };
    const info: HitlInfo = { reason: 'captcha', query: 'q' };
    const gateOpts: InteractiveGateOptions = { keyLabel: 'Key' };
    const solvedOpts: ConfirmSolvedOptions = { actor: 'a' };
    const cliOpts: UnlockCliOptions = { usage: 'Usage: x <key>' };
    const nodeOpts: NodeTripwireIoOptions = { env: {}, isTTY: false };
    const code: UnlockExitCode = await index.runUnlockCli([], io, index
      .createTripwire({
        namespace: 'n',
        stateDir: '/s',
        fs: index.createMemoryFs(),
      }), cliOpts);
    expect(code).toBe(1);
    expect([info, gateOpts, solvedOpts, nodeOpts].length).toBe(4);
    expect(index.renderStatusText({})).toBe('No tripwires tripped.');
  });

  it('[tripwire-interactive.8] TW31 only node-io.ts touches the process ' +
    'streams or environment', () => {
    const lib = join(PKG_ROOT, 'src', 'lib');
    const banned =
      /process\.(env|stdin|stdout|stderr)|child_process|\bconsole\./;
    const offenders = readdirSync(lib)
      .filter((f) => f.endsWith('.ts') && f !== 'node-io.ts')
      .filter((f) => banned.test(readFileSync(join(lib, f), 'utf8')));
    expect(offenders).toEqual([]);
    expect(banned.test(readFileSync(join(lib, 'node-io.ts'), 'utf8')))
      .toBe(true);
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
