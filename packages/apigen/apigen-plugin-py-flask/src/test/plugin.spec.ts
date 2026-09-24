/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `plugin.e2e.ts`.
 *
 * Resource lane: proc — it spawns a real managed Python interpreter per block
 * (a live Flask server on an OS-assigned port, driven by real `fetch`), plus
 * real `npx`/node subprocesses for the negative-control gate.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `plugin.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: py-flask plugin', () => {
  // [LIVE server] — describe.skip in the e2e lane (CPU-THRASH-SKIP).
  it.todo('mocked: GET /_meta/health → 200 with status:ok');
  it.todo('mocked: POST /<ns>/echo_str → 200 plain string round-trip');
  it.todo('mocked: [decimal] POST /<ns>/double_decimal → "123.456" returns exact decimal string');
  it.todo('mocked: [decimal] NEGATIVE — if wire encoding were float, value would differ');
  it.todo('mocked: [datetime] POST /<ns>/get_datetime → RFC3339 string');
  it.todo('mocked: [validation] malformed type → HTTP 400 invalid_argument (fn never called)');
  it.todo('mocked: [validation] missing required param → HTTP 400');
  it.todo('mocked: [envelope] x-adhd-session header forwarded to ctx parameter');
  it.todo('mocked: [not found] unknown route → 404');
  // [batch mount]
  it.todo('mocked: usePlugins: [{id:"batch"}] adds a real, dispatchable _batch/<kind> route (partial-failure fan-out)');
  it.todo('mocked: usePlugins absent (default): the batch route does NOT exist — opt-in only, never a runtime flag');
  // [route/verb parity with project()]
  it.todo('mocked: project(): echo_str (primitive-only input, safe:false) hoists to GET at a 3-segment kebab route');
  it.todo('mocked: project(): sum_ints (array/non-primitive input) stays POST at its 3-segment kebab route');
  it.todo('mocked: LIVE: the server exposes GET at the project()-derived route for echo_str, and the OLD flat route 404s');
  it.todo('mocked: LIVE: the server exposes POST-only at the project()-derived route for sum_ints, and the OLD flat route 404s');
  it.todo('mocked: LIVE: the served stderr route log matches project() for every fixture op');
  // [py-flask-serve-split] parity gate
  it.todo('mocked: recapture deep-equals the committed golden snapshot');
  it.todo('mocked: applying neg-control/py-flask-serve-split.patch turns the golden-parity check RED; reverting turns it GREEN');
  // [BUG-APIGEN-053] parent-death watchdog
  it.todo('mocked: a Python host survives its own spawning process being SIGKILLed, then self-terminates within a bounded deadline (poll, never sleep)');
  it.todo('mocked: a Python host torn down gracefully (normal suite path) also disappears within the same bounded deadline, proven by PID poll');
});
