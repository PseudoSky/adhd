/**
 * guards: a README example fails to compile or run, or the README drifts from the spec
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-docs.4] README examples compile and run.
 * Ticket 8468f7b1 - the README examples, compiled and executed.
 *
 * Every fenced `ts` block of README.md is pasted verbatim (imports aside)
 * between `README-EXAMPLE n BEGIN` / `END` markers below, inside a function
 * that shadows the four things a real program takes from its environment:
 * `createTripwire` (bound to the memory fs), `nodeTripwireIo` (bound to
 * in-memory streams), `process` and `fetch`. The block therefore type-checks
 * and runs exactly as a reader would write it, and the drift tests below
 * fail when the README and the spec diverge or when an example imports a
 * name the package does not export.
 * Criteria: [tripwire-docs.4] README examples compile and run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as index from '../../src/index';
import {
  CONFIRM_TOKEN,
  TripwireAbortedError,
  TripwireTrippedError,
  adhdDataDir,
  confirmSolved,
  createMemoryFs,
  createTripwire as realCreateTripwire,
  defaultRedactor,
  interactiveGate,
  isTripwireTrippedError,
  nodeTripwireIo as realNodeTripwireIo,
  runUnlockCli,
  type AuditEvent,
  type MemoryFs,
  type TripContext,
  type Tripwire,
  type TripwireIo,
  type TripwireOptions,
} from '../../src/index';

const PKG_ROOT = join(__dirname, '..', '..');
const ADHD_HOME = '/home/op/.adhd';

interface FakeResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** What a program sees of its environment, all of it in memory. */
interface Box {
  mfs: MemoryFs;
  createTripwire<C extends TripContext = TripContext>(
    o: TripwireOptions,
  ): Tripwire<C>;
  nodeTripwireIo(): TripwireIo;
  process: {
    env: Record<string, string | undefined>;
    argv: string[];
    exitCode: number | undefined;
  };
  fetch(url: string): Promise<FakeResponse>;
  fetched: string[];
  /** Resolves with the first `process.exitCode` assignment. */
  exit: Promise<number | undefined>;
  stdout(): string;
  stderr(): string;
  end(): Promise<void>;
}

interface BoxOptions {
  mfs?: MemoryFs;
  stdin?: string;
  isTTY?: boolean;
  env?: Record<string, string>;
  args?: string[];
  statuses?: number[];
}

function collect(s: PassThrough): () => string {
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

function makeBox(o: BoxOptions = {}): Box {
  const mfs = o.mfs ?? createMemoryFs();
  const env: Record<string, string | undefined> = {
    ADHD_HOME,
    ...o.env,
  };
  const input = new PassThrough();
  if (o.stdin !== undefined) {
    input.write(o.stdin);
    input.end();
  }
  const out = new PassThrough();
  const err = new PassThrough();
  const stdout = collect(out);
  const stderr = collect(err);
  const statuses = [...(o.statuses ?? [])];
  const fetched: string[] = [];
  let code: number | undefined;
  let settle: (c: number | undefined) => void = () => undefined;
  const exit = new Promise<number | undefined>((r) => {
    settle = r;
  });
  return {
    mfs,
    createTripwire: <C extends TripContext = TripContext>(
      opts: TripwireOptions,
    ): Tripwire<C> => realCreateTripwire<C>({ ...opts, fs: mfs }),
    nodeTripwireIo: () =>
      realNodeTripwireIo({
        input,
        output: out,
        errorOutput: err,
        env,
        isTTY: o.isTTY ?? false,
      }),
    process: {
      env,
      argv: ['node', 'unlock', ...(o.args ?? [])],
      get exitCode(): number | undefined {
        return code;
      },
      set exitCode(c: number | undefined) {
        code = c;
        settle(c);
      },
    },
    fetch: (url: string) => {
      fetched.push(url);
      const status = statuses.shift() ?? 200;
      return Promise.resolve({
        status,
        json: () => Promise.resolve({ ok: true }),
        text: () => Promise.resolve('results'),
      });
    },
    fetched,
    exit,
    stdout,
    stderr,
    end: async () => {
      input.destroy();
      await new Promise((r) => setImmediate(r));
    },
  };
}

function auditOf(mfs: MemoryFs, stateDir: string): AuditEvent[] {
  return (mfs.readText(`${stateDir}/audit.log`) ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as AuditEvent);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the promise to reject');
}

// ------------------------------------------------------------ the examples

async function recipe1(box: Box) {
  const { createTripwire, process, fetch } = box;
  // README-EXAMPLE 1 BEGIN
  const tw = createTripwire({
    namespace: 'request-builder',
    stateDir: adhdDataDir(['request-builder'], process.env),
  });

  async function send(client: string, url: string): Promise<unknown> {
    await tw.assertOpen(client);
    const res = await fetch(url);
    if (res.status >= 400 && res.status <= 499) {
      const t = await tw.trip(client, {
        reason: 'http-4xx',
        context: { lastStatus: res.status, pageUrl: url },
      });
      throw TripwireTrippedError.fromRecord(t.record, {
        responseStatus: res.status,
      });
    }
    return res.json();
  }
  // README-EXAMPLE 1 END
  return { send, tw };
}

async function recipe2(box: Box) {
  const { createTripwire, nodeTripwireIo, process, fetch } = box;
  // README-EXAMPLE 2 BEGIN
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  const tw = createTripwire({
    namespace: 'agent-search',
    stateDir: adhdDataDir(['agent-search'], process.env),
    clearPolicy: 'open',
    expiry: { ttlMs: TWO_HOURS },
  });
  const io = nodeTripwireIo();

  async function search(query: string): Promise<string> {
    await interactiveGate(tw, 'search', io);
    const pageUrl = `https://search.example/?q=${encodeURIComponent(query)}`;
    const res = await fetch(pageUrl);
    if (res.status === 429) {
      await tw.trip('search', { reason: 'captcha', context: { query, pageUrl } });
      await confirmSolved(tw, 'search', { reason: 'captcha', query, pageUrl }, io);
      return search(query);
    }
    await tw.resolve('search');
    return res.text();
  }
  // README-EXAMPLE 2 END
  return { search, tw };
}

function recipe3(box: Box): void {
  const { createTripwire, nodeTripwireIo, process } = box;
  // README-EXAMPLE 3 BEGIN
  const io = nodeTripwireIo();
  const stateDir = adhdDataDir(['request-builder'], io.env);
  const tw = createTripwire({ namespace: 'request-builder', stateDir });
  void runUnlockCli(process.argv.slice(2), io, tw).then((code) => {
    process.exitCode = code;
  });
  // README-EXAMPLE 3 END
}

async function policiesExample(box: Box) {
  const { createTripwire, process } = box;
  // README-EXAMPLE 4 BEGIN
  async function policies(): Promise<{ refused: string; cleared: boolean[] }> {
    const root = adhdDataDir(['policies'], process.env);

    // confirm-token (the default): clear needs the literal token.
    const strict = createTripwire({ namespace: 'app', stateDir: `${root}/strict` });
    await strict.trip('job', { reason: 'rate_limited', context: {} });
    const refused = await strict
      .clear('job', { method: 'programmatic-confirm' })
      .then(() => 'cleared', (e: { code: string }) => e.code);
    const withToken = await strict.clear('job', {
      method: 'programmatic-confirm',
      confirm: CONFIRM_TOKEN,
    });

    // open: no token. For tripwires an automated recovery may clear.
    const open = createTripwire({
      namespace: 'app',
      stateDir: `${root}/open`,
      clearPolicy: 'open',
    });
    await open.trip('job', { reason: 'rate_limited', context: {} });
    const withoutToken = await open.clear('job', { method: 'mcp-clear' });

    return { refused, cleared: [withToken.cleared, withoutToken.cleared] };
  }
  // README-EXAMPLE 4 END
  return policies();
}

function redactionExample(box: Box) {
  const { createTripwire } = box;
  // README-EXAMPLE 5 BEGIN
  const redactor = defaultRedactor();
  const safe = redactor({
    lastStatus: 401,
    headers: { Authorization: 'Bearer abc' },
    pageUrl: 'https://api.example.com/me?token=abc&page=2',
  });
  // { lastStatus: 401, headers: {}, pageUrl: 'https://api.example.com/me?page=2' }

  const tw = createTripwire({
    namespace: 'app',
    stateDir: '/var/lib/app',
    redact: (ctx) => ({ ...ctx, userEmail: '[redacted]' }),
  });
  // README-EXAMPLE 5 END
  return { safe, tw };
}

async function inspectExample(box: Box) {
  const { createTripwire } = box;
  // README-EXAMPLE 6 BEGIN
  async function inspect(): Promise<string[]> {
    const warnings: string[] = [];
    const tw = createTripwire({
      namespace: 'app',
      stateDir: '/var/lib/app',
      onWarning: (w) => warnings.push(`${w.operation}: ${w.message}`),
    });
    await tw.trip('job', { reason: 'banned', context: { account: 'a1' } });
    const tripped = await tw.status();
    return [...Object.keys(tripped), ...warnings];
  }
  // README-EXAMPLE 6 END
  return inspect();
}

// ------------------------------------------------------------- the tests

const REQ_DIR = `${ADHD_HOME}/request-builder`;
const SEARCH_DIR = `${ADHD_HOME}/agent-search`;

describe('[tripwire-docs.4] README recipe 1: a gate in a request pipeline', () => {
  it('a 4xx trips the key, later sends are blocked without reaching the network', async () => {
    const box = makeBox({ statuses: [200, 401] });
    const { send } = await recipe1(box);
    const url = 'https://api.test/me?token=abc';

    await expect(send('acme', url)).resolves.toEqual({ ok: true });

    const tripped = await rejection(send('acme', url));
    expect(isTripwireTrippedError(tripped)).toBe(true);
    const e = tripped as TripwireTrippedError;
    expect(e.key).toBe('acme');
    expect(e.reason).toBe('http-4xx');
    expect(e.responseStatus).toBe(401);

    const blocked = await rejection(send('acme', url));
    expect(isTripwireTrippedError(blocked)).toBe(true);
    expect(box.fetched).toHaveLength(2);

    const lockPath = `${REQ_DIR}/tripwire/acme.lock`;
    const lock = JSON.parse(box.mfs.readText(lockPath) ?? '') as {
      context: Record<string, unknown>;
    };
    expect(lock.context).toEqual({
      lastStatus: 401,
      pageUrl: 'https://api.test/me',
    });
    expect(box.mfs.readText(lockPath)).not.toContain('abc');

    const events = auditOf(box.mfs, REQ_DIR).map((a) => a.event);
    expect(events).toEqual(['tripwire-fired', 'tripwire-gate-blocked']);
  });
});

describe('[tripwire-docs.4] README recipe 2: a human-in-the-loop gate in a CLI', () => {
  const lock = `${SEARCH_DIR}/tripwire/search.lock`;

  it('a captcha trips, the human presses ENTER, the search is retried', async () => {
    const box = makeBox({ statuses: [429, 200], stdin: '\n', isTTY: true });
    const { search } = await recipe2(box);
    await expect(search('cats')).resolves.toBe('results');
    await box.end();

    expect(box.fetched).toHaveLength(2);
    expect(box.mfs.exists(lock)).toBe(false);
    expect(box.stderr()).toContain('HUMAN-IN-THE-LOOP INTERRUPT');
    const cleared = auditOf(box.mfs, SEARCH_DIR).filter(
      (a) => a.event === 'tripwire-cleared',
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ method: 'hitl-retry', reverified: true });
  });

  it('abort keeps the lock; a later run is gated, retry clears it and proceeds', async () => {
    const mfs = createMemoryFs();
    const first = makeBox({ mfs, statuses: [429], stdin: 'abort\n', isTTY: true });
    const a = await recipe2(first);
    const aborted = await rejection(a.search('cats'));
    expect(aborted).toBeInstanceOf(TripwireAbortedError);
    expect(mfs.exists(lock)).toBe(true);

    const second = makeBox({ mfs, statuses: [200], stdin: 'retry\n', isTTY: true });
    const b = await recipe2(second);
    await expect(b.search('cats')).resolves.toBe('results');
    expect(second.stderr()).toContain('TRIPWIRE TRIPPED');
    expect(mfs.exists(lock)).toBe(false);
    await first.end();
    await second.end();
  });

  it('without a TTY the gate aborts and never hangs', async () => {
    const mfs = createMemoryFs();
    const first = makeBox({ mfs, statuses: [429], stdin: 'abort\n', isTTY: true });
    await rejection((await recipe2(first)).search('cats'));
    const second = makeBox({ mfs, statuses: [200], isTTY: false });
    const err = await rejection((await recipe2(second)).search('cats'));
    expect(err).toBeInstanceOf(TripwireAbortedError);
    expect(second.fetched).toHaveLength(0);
    expect(mfs.exists(lock)).toBe(true);
  });
});

describe('[tripwire-docs.4] README recipe 3: an unlock bin in five lines', () => {
  const lock = `${REQ_DIR}/tripwire/tinder.lock`;

  async function trippedFs(): Promise<MemoryFs> {
    const mfs = createMemoryFs();
    const tw = realCreateTripwire({
      namespace: 'request-builder',
      stateDir: REQ_DIR,
      fs: mfs,
    });
    await tw.trip('tinder', {
      reason: 'http-4xx',
      context: { lastStatus: 401, lastOperationId: 'getProfile' },
    });
    return mfs;
  }

  it('CONFIRM in the environment unlocks and exits 0', async () => {
    const mfs = await trippedFs();
    const box = makeBox({
      mfs,
      args: ['tinder'],
      env: { CONFIRM: CONFIRM_TOKEN },
    });
    recipe3(box);
    await expect(box.exit).resolves.toBe(0);
    expect(box.stdout()).toBe('unlocked tripwire for tinder\n');
    expect(box.stderr()).toContain('reason:          http-4xx');
    expect(mfs.exists(lock)).toBe(false);
    const cleared = auditOf(mfs, REQ_DIR).filter(
      (a) => a.event === 'tripwire-cleared',
    );
    expect(cleared[0]?.method).toBe('unlock-cli-env');
    await box.end();
  });

  it('the TTY prompt unlocks (unlock-cli-tty)', async () => {
    const mfs = await trippedFs();
    const box = makeBox({
      mfs,
      args: ['tinder'],
      stdin: `${CONFIRM_TOKEN}\n`,
      isTTY: true,
    });
    recipe3(box);
    await expect(box.exit).resolves.toBe(0);
    expect(mfs.exists(lock)).toBe(false);
    const cleared = auditOf(mfs, REQ_DIR).filter(
      (a) => a.event === 'tripwire-cleared',
    );
    expect(cleared[0]?.method).toBe('unlock-cli-tty');
    await box.end();
  });

  it('exits 1 and keeps the lock without a TTY and without CONFIRM', async () => {
    const mfs = await trippedFs();
    const box = makeBox({ mfs, args: ['tinder'] });
    recipe3(box);
    await expect(box.exit).resolves.toBe(1);
    expect(box.stderr()).toContain('No TTY');
    expect(mfs.exists(lock)).toBe(true);
    await box.end();
  });

  it('exits 1 on a wrong confirmation and 1 with no key; 0 when nothing is tripped', async () => {
    const mfs = await trippedFs();
    const wrong = makeBox({ mfs, args: ['tinder'], env: { CONFIRM: 'nope' } });
    recipe3(wrong);
    await expect(wrong.exit).resolves.toBe(1);
    expect(mfs.exists(lock)).toBe(true);

    const noKey = makeBox({ mfs });
    recipe3(noKey);
    await expect(noKey.exit).resolves.toBe(1);
    expect(noKey.stderr()).toContain('Usage:');

    const none = makeBox({ args: ['other'] });
    recipe3(none);
    await expect(none.exit).resolves.toBe(0);
    expect(none.stdout()).toBe('no tripwire to unlock for other\n');
  });
});

describe('[tripwire-docs.4] README clear policies', () => {
  it('confirm-token refuses without the token, open does not need one', async () => {
    const box = makeBox();
    const r = await policiesExample(box);
    expect(r).toEqual({
      refused: 'TRIPWIRE_CONFIRM_REQUIRED',
      cleared: [true, true],
    });
    const root = `${ADHD_HOME}/policies`;
    expect(box.mfs.exists(`${root}/strict/tripwire/job.lock`)).toBe(false);
    expect(box.mfs.exists(`${root}/open/tripwire/job.lock`)).toBe(false);
  });
});

describe('[tripwire-docs.4] README redaction', () => {
  it('the default redactor and a custom redact behave as documented', async () => {
    const box = makeBox();
    const { safe, tw } = redactionExample(box);
    expect(safe).toEqual({
      lastStatus: 401,
      headers: {},
      pageUrl: 'https://api.example.com/me?page=2',
    });
    await tw.trip('job', {
      reason: 'banned',
      context: { userEmail: 'a@example.com', apiToken: 'x', responseBody: 'b' },
    });
    const lock = JSON.parse(
      box.mfs.readText('/var/lib/app/tripwire/job.lock') ?? '',
    ) as { context: Record<string, unknown> };
    expect(lock.context).toEqual({ userEmail: '[redacted]' });
  });
});

describe('[tripwire-docs.4] README failure behavior', () => {
  it('status lists the tripped key and a healthy disk gives no warnings', async () => {
    const box = makeBox();
    await expect(inspectExample(box)).resolves.toEqual(['job']);
  });

  it('a lock that cannot be written still blocks and warns through onWarning', async () => {
    const box = makeBox();
    box.mfs.failOn({
      op: ['openExclusive', 'link'],
      path: /\/tripwire\//,
      code: 'EACCES',
    });
    const warnings: string[] = [];
    const tw = box.createTripwire({
      namespace: 'app',
      stateDir: '/var/lib/app',
      onWarning: (w) => warnings.push(w.operation),
    });
    const t = await tw.trip('job', { reason: 'banned', context: {} });
    expect(t.persisted).toBe(false);
    expect((await tw.gate('job')).open).toBe(false);
    expect(warnings).toContain('trip.persist');
  });
});

// ------------------------------------------------- the runbook claims

describe('[tripwire-docs.4] docs/RECOVERY.md: the break-glass rm and the sidecars', () => {
  const dir = '/srv/app';

  async function tripAndBlock(mfs: MemoryFs) {
    const tw = realCreateTripwire({ namespace: 'app', stateDir: dir, fs: mfs });
    await tw.trip('tinder', { reason: 'http-4xx', context: {} });
    await tw.gate('tinder');
    await tw.gate('tinder');
    return tw;
  }

  it('the lock, a generation sidecar of one byte per block and the cleared marker have the documented names', async () => {
    const mfs = createMemoryFs();
    const tw = await tripAndBlock(mfs);
    const lock = JSON.parse(mfs.readText(`${dir}/tripwire/tinder.lock`) ?? '') as {
      generation: string;
    };
    expect(lock.generation).toMatch(/^[0-9a-f]{24}$/);
    const sidecar = `${dir}/tripwire/tinder.blocked.${lock.generation}`;
    expect(mfs.readBytes(sidecar)?.length).toBe(2);
    expect((await tw.read('tinder')).record?.blockedCount).toBe(2);

    await tw.clear('tinder', { method: 'programmatic-confirm', confirm: CONFIRM_TOKEN });
    const marker = JSON.parse(mfs.readText(`${dir}/tripwire/tinder.cleared`) ?? '') as {
      method: string;
    };
    expect(marker.method).toBe('programmatic-confirm');
    expect(mfs.exists(`${dir}/tripwire/tinder.lock`)).toBe(false);

    await tw.trip('tinder', { reason: 'http-4xx', context: {} });
    const next = (await tw.read('tinder')).record;
    expect(next?.priorClear?.method).toBe('programmatic-confirm');
    expect(mfs.exists(`${dir}/tripwire/tinder.cleared`)).toBe(false);
  });

  it('rm of the lock opens the gate, writes no cleared marker or audit line and leaves the sidecar', async () => {
    const mfs = createMemoryFs();
    const tw = await tripAndBlock(mfs);
    const before = auditOf(mfs, dir).length;
    await mfs.unlink(`${dir}/tripwire/tinder.lock`);

    expect((await tw.gate('tinder')).open).toBe(true);
    expect(mfs.exists(`${dir}/tripwire/tinder.cleared`)).toBe(false);
    expect(auditOf(mfs, dir)).toHaveLength(before);
    expect(
      mfs.files().filter((f) => f.includes('/tinder.blocked.')),
    ).toHaveLength(1);
  });

  it('the audit log is at <stateDir>/audit.log, not under tripwire/', async () => {
    const mfs = createMemoryFs();
    await tripAndBlock(mfs);
    expect(mfs.exists(`${dir}/audit.log`)).toBe(true);
    expect(auditOf(mfs, dir).map((a) => a.event)).toEqual([
      'tripwire-fired',
      'tripwire-gate-blocked',
      'tripwire-gate-blocked',
    ]);
  });
});

// ------------------------------------------------------- drift guards

/** Lines trimmed, blank lines dropped: indentation is not content. */
function normalise(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

const IMPORT_RE = /^import[\s\S]*?from '[^']+';\n/gm;

function readmeBlocks(): string[] {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8');
  return [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map(
    (m) => m[1] ?? '',
  );
}

function specRegions(): Map<number, string> {
  const spec = readFileSync(join(__dirname, 'readme-examples.spec.ts'), 'utf8');
  const out = new Map<number, string>();
  const re = /\/\/ README-EXAMPLE (\d+) BEGIN\n([\s\S]*?)\/\/ README-EXAMPLE \1 END/g;
  for (const m of spec.matchAll(re)) out.set(Number(m[1]), m[2] ?? '');
  return out;
}

describe('[tripwire-docs.4] the README and this spec cannot drift', () => {
  it('every ts block of the README is pasted verbatim in a spec region, in order', () => {
    const blocks = readmeBlocks();
    const regions = specRegions();
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(regions.size).toBe(blocks.length);
    blocks.forEach((block, i) => {
      const region = regions.get(i + 1);
      expect(region, `no spec region for README example ${i + 1}`).toBeDefined();
      expect(normalise(block.replace(IMPORT_RE, ''))).toBe(
        normalise(region ?? ''),
      );
    });
  });

  it('every name a README example imports is a runtime export of the package', () => {
    const exported = new Set(Object.keys(index));
    for (const block of readmeBlocks()) {
      const imports = [...block.matchAll(/^import\s*\{([^}]*)\}\s*from '([^']+)';/gm)];
      expect(imports.length).toBeGreaterThan(0);
      for (const m of imports) {
        expect(m[2]).toBe('@adhd/resilience-core-tripwire');
        const names = (m[1] ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n !== '');
        for (const n of names) {
          expect(exported.has(n), `${n} is not exported`).toBe(true);
        }
      }
    }
  });

  it('the documents the README links to exist', () => {
    for (const f of ['docs/ERRORS.md', 'docs/RECOVERY.md', 'CHANGELOG.md']) {
      expect(existsSync(join(PKG_ROOT, f)), f).toBe(true);
    }
  });
});
