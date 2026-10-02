import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { Plugin, Call, Next, Result, Chunk, File } from '@adhd/apigen-core-client';
import {
  withSpan,
  log,
  newTraceId,
  currentTraceId,
  withTrace,
  currentRuntimeState,
} from '@adhd/sox-telemetry';
import type { OtelSpanHandle } from '@adhd/sox-telemetry';

/**
 * ---------------------------------------------------------------------------
 * Process-identity attributes — resolved once per process, then frozen. These are
 * first-class reserved attributes (spread LAST in the layer so a configured
 * `envelopeAttrs` entry can never shadow them) and give every span enough tagging
 * to aggregate by session, trace, parent, worktree, role, and release across a
 * whole process run.
 *
 *   - `session_id`        — `ADHD_SESSION_ID` env when set, else a process-stable
 *                           `randomUUID()`. Stable for the process, never per-span.
 *   - `trace_id`          — the OTel trace id (existing; see the layer body).
 *   - `parent_span_id`    — NOT emitted here: the OTel facade the plugin sees
 *                           (`OtelSpanHandle`) exposes only `setAttributes` /
 *                           `recordError`, no span/parent identity. sox-telemetry's
 *                           `JsonlSpanProcessor` stamps `parent_span_id` on every
 *                           span record (empty at the root, the parent's id when
 *                           nested) — see `otel.ts` in @adhd/sox-telemetry.
 *   - `worktree`          — `true` when `process.cwd()` sits inside a LINKED git
 *                           worktree (vs. the main checkout), else `false`.
 *   - `role`              — `currentRuntimeState().role`, matching the envelope's
 *                           `role` exactly so test/cli/live-service/harness
 *                           populations aggregate together.
 *   - `release.*`         — the running artifact's release identity, self-resolved
 *                           here because the installed sox-telemetry (0.3.x) does
 *                           not stamp it: `release.version` from
 *                           `npm_package_version`, `release.git_sha` from
 *                           `git rev-parse HEAD`, `release.artifact_sha256` from
 *                           `sha256(process.argv[1])`. Each is present ONLY when it
 *                           genuinely resolved — a null is omitted, never fabricated.
 * ---------------------------------------------------------------------------
 */

/** Run `git rev-parse <args>` in `process.cwd()`; trimmed stdout on success, else null. */
function gitRevParse(args: string[]): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      const out = result.stdout.trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    /* git missing / not a repo / timeout — caller falls back to null */
  }
  return null;
}

/** `sha256:<hex>` of the running entrypoint (`process.argv[1]`), else null. */
function artifactSha256(): string | null {
  const entry = process.argv[1];
  if (entry === undefined) return null;
  try {
    return `sha256:${createHash('sha256').update(readFileSync(entry)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** True when `process.cwd()` sits inside a LINKED git worktree (not the main checkout). */
function isLinkedWorktree(): boolean {
  const top = gitRevParse(['--show-toplevel']);
  const commonDir = gitRevParse(['--path-format=absolute', '--git-common-dir']);
  if (top === null || commonDir === null) return false;
  return /[\\/]\.git$/.test(commonDir) && resolve(dirname(commonDir)) !== resolve(top);
}

interface ProcessIdentity {
  sessionId: string;
  worktree: boolean;
  release: { version: string | null; gitSha: string | null; artifactSha256: string | null };
}

let cachedIdentity: ProcessIdentity | null = null;

/** Resolve the process-stable identity once; every later call returns the same value. */
function processIdentity(): ProcessIdentity {
  if (cachedIdentity === null) {
    const sessionEnv = process.env['ADHD_SESSION_ID'];
    const versionEnv = process.env['npm_package_version'];
    cachedIdentity = {
      sessionId: sessionEnv !== undefined && sessionEnv.length > 0 ? sessionEnv : randomUUID(),
      worktree: isLinkedWorktree(),
      release: {
        version: versionEnv !== undefined && versionEnv.length > 0 ? versionEnv : null,
        gitSha: gitRevParse(['HEAD']),
        artifactSha256: artifactSha256(),
      },
    };
  }
  return cachedIdentity;
}

/**
 * Options for {@link makeTracingPlugin}.
 *
 * Layer plugins receive no opts at call time — `LayerCapability.layer` is invoked with only
 * `(call, next)` — so configuration is a factory, exactly as `makeLoggerPlugin` does it.
 */
export type TracingOptions = {
  /**
   * Span / record / attribute name prefix — the emitting product's namespace. REQUIRED: there
   * is no implicit default, so a product cannot silently emit another product's telemetry.
   * adhd products pass `'adhd'`; apigen's own CLI and self-test pass `'apigen'` explicitly.
   */
  serviceName: string;
  /**
   * Extra attribute keys copied verbatim from `call.envelope` onto each span. Default: `[]`
   * (only the built-in attrs `${serviceName}.op`, `${serviceName}.transport`, `trace_id` are
   * emitted).
   */
  envelopeAttrs?: readonly string[];
};

/**
 * Per-call trace handle, seeded into `call.ctx`. The class is the ctx token: domain code reads
 * it back with `call.ctx.get(TraceHandle)`.
 */
export class TraceHandle {
  constructor(
    /** Correlation id shared by every span of one logical request. */
    readonly traceId: string,
    /** Span name — `${serviceName}.${operation.id}`. */
    readonly spanName: string,
    /** Epoch millis at which the span opened. */
    readonly startedAt: number
  ) {}

  /**
   * Add attributes to the live span from domain code — opt-in. A no-op when the operation is
   * not currently inside a unary span (e.g. before the downstream resolved, or after the span
   * has closed). Streaming is not special-cased: the layer spans a streaming op as a unary
   * span covering only the point the stream is obtained.
   */
  annotate(fields: Record<string, unknown>): void {
    const span = boundSpans.get(this);
    if (span === undefined) return;
    span.setAttributes(toOtelAttributes(fields));
  }
}

/**
 * WeakMap from a live {@link TraceHandle} to the OTel span it is bound to for the duration of a
 * unary call. Populated on span entry, cleared in `finally`. Keeps `TraceHandle`'s public shape
 * exactly the spec's (`traceId`/`spanName`/`startedAt`/`annotate`) with no extra public members.
 */
const boundSpans = new WeakMap<TraceHandle, OtelSpanHandle>();

/**
 * QUARANTINED — unreachable under the current `Next` contract; see CONTRACT-FIX §4.
 * Exported only so the streaming branch can be exercised by a direct unit test; no layer
 * path reaches it (a `Next` resolves to a `LayerResult`, so this detector can never be
 * true for the unresolved `next()` promise). Not re-exported from the package entry
 * (`src/index.ts`), so it is not part of the public API either. Retained — never
 * deleted — pending a `Next` that can yield an iterable before resolution.
 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<Chunk> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/** Keep only the attribute types the OTel attribute contract admits (string | number | boolean). */
function toOtelAttributes(
  fields: Record<string, unknown>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Copy only the requested keys that are actually present on the envelope. */
function pickEnvelope(
  envelope: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = envelope[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Best-effort human-readable message for an arbitrary thrown value (never `{}` for an Error). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Unary branch — wrap the downstream promise in an OTel span. `withSpan` writes the
 * `<spanName>.start` record BEFORE invoking the body (so a hang is visible) and the
 * `<spanName>.finish` / `<spanName>.error` record on completion. We additionally emit a
 * `${serviceName}.op.error` record and re-throw — the layer never swallows.
 */
function traceUnary(
  downstream: Promise<Result>,
  spanName: string,
  attrs: Record<string, unknown>,
  handle: TraceHandle,
  serviceName: string
): Promise<Result> {
  return withSpan(spanName, toOtelAttributes(attrs), async (span) => {
    boundSpans.set(handle, span);
    try {
      return await downstream;
    } catch (err) {
      log.error(`${serviceName}.op.error`, {
        ...attrs,
        span: spanName,
        duration_ms: Date.now() - handle.startedAt,
        err: errMessage(err),
      });
      throw err;
    } finally {
      boundSpans.delete(handle);
    }
  });
}

/**
 * QUARANTINED — unreachable under the current `Next` contract; see CONTRACT-FIX §4.
 * The layer no longer branches on `next()` (an `AsyncIterable` can only be a *resolved*
 * value, never the unresolved promise), so this is retained with its body intact and
 * exported solely for a direct unit test (and not re-exported from the package entry
 * `src/index.ts`, so not part of the public API). Do NOT re-wire it into the layer by
 * awaiting `next()` first — that would destroy the span-before-body invariant guarded by
 * `plugin.spec.ts` (the hang-visibility test).
 *
 * Streaming branch — `withSpan` cannot await an iterable, so the `.start` record is emitted
 * synchronously on entry and an async-generator wrapper yields each chunk unchanged, then
 * emits `.finish` with the chunk count (or `.error` and re-throws).
 */
export function traceStream(
  downstream: AsyncIterable<Chunk>,
  spanName: string,
  attrs: Record<string, unknown>
): AsyncIterable<Chunk> {
  log.info(`${spanName}.start`, { ...attrs });
  return (async function* traced(): AsyncGenerator<Chunk> {
    const startedAt = Date.now();
    let chunks = 0;
    try {
      for await (const chunk of downstream) {
        chunks += 1;
        yield chunk;
      }
      log.info(`${spanName}.finish`, {
        ...attrs,
        chunks,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      log.error(`${spanName}.error`, {
        ...attrs,
        chunks,
        duration_ms: Date.now() - startedAt,
        err: errMessage(err),
      });
      throw err;
    }
  })();
}

/**
 * Build the tracing layer for a given configuration. The returned layer calls `next()` exactly
 * once and returns its resolved value (or iterable) unchanged, wrapping it in a span.
 */
export function makeTraceLayer(
  opts: TracingOptions
): (call: Call, next: Next) => Promise<Result> | AsyncIterable<Chunk> {
  const serviceName = opts.serviceName;
  // Required by the type, but a JS caller (or an untyped `any`) bypasses that: an absent or
  // blank name would silently stamp every span with `undefined.op` / `undefined.transport` and
  // name records `undefined.<op>`, poisoning the sink instead of failing loudly. Fail fast.
  if (typeof serviceName !== 'string' || serviceName.trim() === '') {
    throw new Error(
      '@adhd/apigen-plugin-tracing: `serviceName` is required and must be a non-empty string — ' +
        'it namespaces every span name, attribute key, and error record. Construct the plugin ' +
        'explicitly, e.g. `makeTracingPlugin({ serviceName: "adhd" })`.'
    );
  }
  const envelopeAttrs = opts.envelopeAttrs ?? [];

  return (call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk> => {
    const spanName = `${serviceName}.${call.operation.id}`;
    const traceId = currentTraceId() ?? newTraceId();
    const startedAt = Date.now();
    const handle = new TraceHandle(traceId, spanName, startedAt);

    // Seed the per-call trace handle so downstream layers / domain code can correlate + annotate.
    call.ctx.set(TraceHandle, handle);

    // Reserved keys are spread LAST so a configured `envelopeAttrs` entry can never shadow
    // `${serviceName}.op` / `${serviceName}.transport` / `trace_id` / the process-identity
    // attrs — the built-in attrs always win (F14).
    const identity = processIdentity();
    const attrs: Record<string, unknown> = {
      ...pickEnvelope(call.envelope, envelopeAttrs),
      [`${serviceName}.op`]: call.operation.id,
      [`${serviceName}.transport`]: call.transport,
      trace_id: traceId,
      session_id: identity.sessionId,
      worktree: identity.worktree,
      role: currentRuntimeState().role,
    };
    // Release identity is carried as dotted `release.*` keys — the OTel attribute contract is
    // flat (string | number | boolean), so a nested `release` object would be dropped by
    // `toOtelAttributes`. Each key is present ONLY when it genuinely resolved; a null is
    // omitted, never fabricated (a null "sha256:…" would be indistinguishable from a real one).
    if (identity.release.version !== null) attrs['release.version'] = identity.release.version;
    if (identity.release.gitSha !== null) attrs['release.git_sha'] = identity.release.gitSha;
    if (identity.release.artifactSha256 !== null) {
      attrs['release.artifact_sha256'] = identity.release.artifactSha256;
    }

    // Run the whole downstream inside the trace context so nested spans share the trace_id.
    // `next()` resolves to a `LayerResult`; the unary span is opened unconditionally (and
    // BEFORE the body runs) so a hanging downstream is still visible. The streaming branch
    // is quarantined — see below — because branching on the unresolved `next()` promise is
    // always false (an `AsyncIterable` can only be a resolved value), and awaiting first
    // would destroy the span-before-body invariant. `traceUnary` remains the only layer path.
    // `Next` in scope is @adhd/apigen-core-client's broad authoring union
    // `() => Promise<Result> | AsyncIterable<Chunk>`; engine-runtime always hands a Layer a
    // Promise (its own `Next` is `() => Promise<LayerResult>`), so `Promise.resolve` is a
    // no-op on the real path and merely re-narrows the static type for `traceUnary`. It never
    // branches on, and never awaits, the unresolved value — the span still opens first.
    return withTrace(traceId, () =>
      traceUnary(Promise.resolve(next()), spanName, attrs, handle, serviceName)
    );
  };
}

/**
 * Tracing plugin.
 *
 * Implemented as a **Layer** capability — a single layer instruments every transport (http, grpc,
 * mcp, cli) because they all dispatch through one composed invoker. The `target` capability is
 * declared but emits nothing (`generate()` returns `[]`), so `--type tracing` resolves to a valid
 * no-op rather than an error — the same precedent as `apigen-plugin-logger`.
 */
export const tracingPlugin: Plugin<TracingOptions> = {
  id: 'tracing',
  description:
    'Layer plugin: emits one OTel span per dispatched operation (op id, transport, outcome, duration) to the sox-telemetry JSONL sink, correlated by trace_id.',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      serviceName: {
        type: 'string',
        description:
          'Span / record / attribute name prefix. REQUIRED — the emitting product namespace (e.g. adhd).',
      },
      envelopeAttrs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra envelope keys copied verbatim onto each span. Default: [].',
      },
    },
    required: ['serviceName'],
    additionalProperties: false,
  },
  capabilities: {
    // Declared so `--type tracing` resolves instead of erroring; emits NOTHING — parity with
    // logger's `generate() { return [] }`.
    target: {
      name: 'tracing',
      generate(): File[] {
        return [];
      },
    },
    layer: {
      // `'apigen'` is apigen's OWN namespace, for its self-test and CLI transports — an explicit
      // constant, not a fallback. adhd products must NOT import this singleton: they construct
      // `makeTracingPlugin({ serviceName: 'adhd' })` at their call site.
      layer: makeTraceLayer({ serviceName: 'apigen' }),
    },
  },
};

/** Configured factory — rebuilds the layer with `opts` (logger precedent). */
export function makeTracingPlugin(opts: TracingOptions): Plugin<TracingOptions> {
  return {
    ...tracingPlugin,
    capabilities: {
      ...tracingPlugin.capabilities,
      layer: { layer: makeTraceLayer(opts) },
    },
  };
}

export default tracingPlugin;
