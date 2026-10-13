# @adhd/resilience-core-tripwire

A persistent kill-switch latch for code that must stop and stay stopped.

When a request is rejected, a captcha appears or an account is banned, a
retry loop only makes things worse. A tripwire records the first failure in a
human-readable lock file, closes every later `gate` on that key, and keeps it
closed until a human (or an explicitly `open` policy) clears it. It is a
latch, not a circuit breaker: it never half-opens on its own and never retries.

- Zero runtime dependencies, CommonJS, Node 20 or newer.
- Lock file per key, NDJSON audit trail, per-trip block counter.
- Fail closed: a lock that cannot be read counts as tripped.
- Secrets are stripped from everything it persists.
- One entry point, no subpath exports.

## Install

```sh
pnpm add @adhd/resilience-core-tripwire
```

Everything below is imported from the package root.

## Concepts

A tripwire has a `namespace` (the owner written into records and audit
lines), a `stateDir` (where it keeps its files) and any number of independent
keys. A key matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and is validated
before any file is touched.

| Call | What it does |
| --- | --- |
| `gate(key)` | `{ open, snapshot }`. While tripped it counts and audits one block. |
| `assertOpen(key)` | `gate`, throwing `TripwireTrippedError` while tripped. |
| `trip(key, { reason, context })` | Latches the key. The first trip wins; a second keeps the first record. Never throws on IO. |
| `clear(key, opts)` | Clears under the instance policy (see below). |
| `resolve(key)` | The success path: audits `tripwire-resolved`, then clears under any policy. |
| `read(key)` / `status()` | Inspect one key, or the sparse map of every tripped key. No side effects. |

## Recipe 1: a gate in a request pipeline

Gate before the work, trip on the failure. `assertOpen` throws while the key
is tripped, so a blocked client never reaches the network again.

```ts
import {
  TripwireTrippedError,
  adhdDataDir,
  createTripwire,
} from '@adhd/resilience-core-tripwire';

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
```

The thrown error carries `key`, `reason`, `trippedAt` and a `recoveryHint`.
Recognise it with `isTripwireTrippedError(e)`, which also works across two
copies of the package. The response status and body ride on the error in
memory only; they are never written to disk.

## Recipe 2: a human-in-the-loop gate in a CLI

`interactiveGate` is the pre-work gate: while the key is tripped it prints a
banner on stderr and asks `[retry/clear/abort]`. `confirmSolved` is the
post-trip prompt: "solve the challenge in the browser, then press ENTER".
Both throw `TripwireAbortedError` and keep the lock when there is no TTY, the
input reaches EOF, or the human types `abort`. They never hang.

```ts
import {
  adhdDataDir,
  confirmSolved,
  createTripwire,
  interactiveGate,
  nodeTripwireIo,
} from '@adhd/resilience-core-tripwire';

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
```

This instance uses the `open` clear policy, so the human's answer is the
confirmation. On a `confirm-token` instance the gates also need
`{ confirm: CONFIRM_TOKEN }` in their options: a TTY alone is never treated as
the token. `expiry` makes a lock lapse after two hours; the next `gate`
removes it and audits `tripwire-expired`. Without `expiry` a lock never
expires.

## Recipe 3: an unlock bin in five lines

`runUnlockCli` is the whole body of an unlock tool. It prints the lock
(reason, trippedAt, lastStatus, lastOperationId), asks for confirmation and
clears. It never calls `process.exit`; it returns the exit code.

```ts
import {
  adhdDataDir,
  createTripwire,
  nodeTripwireIo,
  runUnlockCli,
} from '@adhd/resilience-core-tripwire';

const io = nodeTripwireIo();
const stateDir = adhdDataDir(['request-builder'], io.env);
const tw = createTripwire({ namespace: 'request-builder', stateDir });
void runUnlockCli(process.argv.slice(2), io, tw).then((code) => {
  process.exitCode = code;
});
```

Run it as `unlock <key>`. Confirmation is the `CONFIRM` environment variable
(scripted, audited as `unlock-cli-env`) or the typed prompt on a TTY (audited
as `unlock-cli-tty`); the required text is `CONFIRM_TOKEN`
(`I-UNDERSTAND-THE-RISK`).

| Exit | Meaning |
| --- | --- |
| 0 | Unlocked, or no lock was present. |
| 1 | No key given, invalid key, no TTY and no `CONFIRM`, or the confirmation did not match. The lock is kept. |
| 2 | Unexpected IO error. |

Pass `{ lockPath: (k) => ... }` to show the lock file location in the
messages, and `{ usage, actor }` to change the usage line and the audited
actor.

## stateDir and ADHD_HOME

Locks live at `<stateDir>/tripwire/<key>.lock` and the audit log defaults to
`<stateDir>/audit.log` (override with `auditPath`). The package never picks a
directory for you: `stateDir` is required.

`adhdDataDir(segments, env, home?)` is the shared convention. It returns
`<ADHD_HOME>/<segments...>`, and falls back to `~/.adhd` when `ADHD_HOME` is
unset or blank. It is pure: it reads the `env` you pass (it defaults to an
empty object), so pass `process.env` as in the recipes above.

## Clear policies: confirm-token and open

```ts
import {
  CONFIRM_TOKEN,
  adhdDataDir,
  createTripwire,
} from '@adhd/resilience-core-tripwire';

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
```

- `confirm-token` is the default and the safe choice. `clear` without
  `confirm: CONFIRM_TOKEN` throws `TripwireConfirmError` and changes nothing.
- `open` lets any caller clear. Use it only when the recovery is automated
  or the human at the keyboard is the confirmation, as in recipe 2.
- `resolve(key)` clears under either policy; call it when the upstream has
  demonstrably recovered.

## Redaction

Everything in `context` is redacted before it is written, and the audit log
never contains `context` at all. The default redactor (`defaultRedactor()`):

- drops any value whose key matches `authorization`, `cookie`, `set-cookie`,
  `token`, `secret`, `password` or `x-auth`, at any depth;
- removes secret-looking query parameters (`token`, `key`, `sig`, `session`,
  `api_key` and similar) and URL credentials from URL strings;
- truncates strings over 2048 characters;
- coerces the result to plain JSON, dropping functions and `undefined`;
- never persists `responseBody` or `responseStatus`, whatever a custom
  redactor returns.

A `redact` option runs after the default one; it can remove more but it
cannot turn the defaults off. The audit log records only the origin and path
of `pageUrl`, never its query or fragment.

```ts
import { createTripwire, defaultRedactor } from '@adhd/resilience-core-tripwire';

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
```

## Failure behavior

The tripwire fails closed and tells you when it is degraded.

- Only an absent lock file is "clear". A lock that is empty, corrupt, of an
  unknown schema or unreadable counts as tripped (`status: 'unreadable'`,
  reason `unreadable-lock`).
- `trip` never throws on IO. If the lock cannot be written, an in-memory
  latch still blocks this process and `persisted` is `false`.
- Audit and counter writes are best effort. Failures go to `onWarning`
  (`TripwireWarning`, code `TRIPWIRE_IO`) and never reach the caller.
- `clear` and `resolve` do throw `TripwireIoError` when the lock cannot be
  removed.

```ts
import { createTripwire } from '@adhd/resilience-core-tripwire';

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
```

## Local disk only, not NFS

The lock protocol relies on atomic create-if-absent (`link` / exclusive
create), `rename` and `O_APPEND` writes. These are atomic on a local
filesystem and are not reliable on NFS or other network filesystems, where a
second host can see a lock that is not there yet. Keep `stateDir` on a local
disk, one per host. Files are created with mode `0600` and directories `0700`.

## More

- [docs/ERRORS.md](docs/ERRORS.md): every error code with its class, cause and remediation.
- [docs/RECOVERY.md](docs/RECOVERY.md): the operator runbook (break-glass `rm`, sidecars, reading the audit log).
- [CHANGELOG.md](CHANGELOG.md)

Every `ts` example in this file is compiled and executed against an in-memory
filesystem by `src/test/unit/readme-examples.spec.ts`, so the examples cannot
drift from the code.

## Building and testing

Run `nx build resilience-core-tripwire` to build the library and
`nx test resilience-core-tripwire` to run the unit tests with
[Vitest](https://vitest.dev/).
