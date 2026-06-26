import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type {
  Plugin,
  Descriptor,
  Call,
  Next,
  Result,
  Chunk,
  File,
} from '@adhd/apigen-core';

// Plugin-specific options — extend as needed.
export interface LoggerOptions {
  /** pino log level. Default: `info`. */
  level?: string;
  /**
   * Output format. `pretty` is colorized human-readable; `json` is raw jsonl.
   * Default: `pretty` when stderr is a TTY, else `json`.
   */
  format?: 'json' | 'pretty';
  /**
   * Where logs are written. Default: stderr (fd 2) — NEVER stdout, which is the
   * MCP stdio JSON-RPC channel.
   */
  destination?: string;
}

// ---------------------------------------------------------------------------
// Logger — the typed-extension ctx key (§8.1 rule 3)
//
// The class constructor itself is the ctx token: `call.ctx.set(Logger, instance)`.
// Downstream layers and domain functions read it back with `call.ctx.get(Logger)`.
// Using a class key avoids symbol export/import mismatches and matches the
// `http::Extensions` / Tower pattern described in §8.1.
// ---------------------------------------------------------------------------

/**
 * Typed ctx extension key for the per-request pino Logger (SPEC §8.1 rule 3).
 *
 * Layers insert a Logger bound to this key; downstream layers and domain
 * functions retrieve it via `call.ctx.get(Logger)`.
 *
 * @example
 * ```ts
 * // In the logger layer (already done by loggerPlugin):
 * call.ctx.set(Logger, pinoInstance.child({ op: call.operation.id }))
 * // In a downstream layer or domain function:
 * const log = call.ctx.get(Logger)
 * log?.info('hello from domain fn')
 * ```
 */
export class Logger {
  constructor(private readonly _inner: PinoLogger) {}

  info(obj: Record<string, unknown>, msg: string): void {
    this._inner.info(obj, msg);
  }

  error(obj: Record<string, unknown>, msg: string): void {
    this._inner.error(obj, msg);
  }

  debug(obj: Record<string, unknown>, msg: string): void {
    this._inner.debug(obj, msg);
  }

  warn(obj: Record<string, unknown>, msg: string): void {
    this._inner.warn(obj, msg);
  }

  /** Access the underlying pino logger for advanced usage. */
  get pino(): PinoLogger {
    return this._inner;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build or retrieve the per-request Logger from `call.ctx`.
 * If the caller (or a prior layer) already seeded one, use it;
 * otherwise fall back to the module-level root logger.
 */
function getOrInsertLogger(call: Call, root: Logger): Logger {
  const existing = call.ctx.get(Logger);
  if (existing !== undefined) return existing;
  // Bind op-id so every log line carries it without repetition.
  const child = new Logger(root.pino.child({ op: call.operation.id }));
  call.ctx.set(Logger, child);
  return child;
}

/**
 * Build the root pino logger from plugin options.
 * Always targets stderr — never stdout, which is the MCP stdio JSON-RPC channel.
 */
function buildRootLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'info';
  const toFile =
    typeof opts.destination === 'string' && opts.destination.length > 0;
  const isTty = !toFile && Boolean(process.stderr.isTTY);
  const format = opts.format ?? (isTty ? 'pretty' : 'json');

  let inner: PinoLogger;
  if (format === 'pretty') {
    inner = pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: !toFile,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          ...(toFile
            ? { destination: opts.destination, mkdir: true }
            : { destination: 2 }),
        },
      },
    });
  } else {
    const dest = toFile
      ? pino.destination({
          dest: opts.destination,
          mkdir: true,
          sync: true,
        })
      : pino.destination(2);
    inner = pino({ level }, dest);
  }

  return new Logger(inner);
}

// Module-level default root logger (json → stderr). Overridden per-plugin
// instantiation via the `layer` closure below when opts are resolved at
// compose time.  For tests the default is always json/stderr.
const _defaultRoot = new Logger(pino({ level: 'info' }, pino.destination(2)));

// ---------------------------------------------------------------------------
// The layer function — stream-lifecycle aware (SPEC §8.1 + §11)
//
// For unary ops  : logs entry → awaits next() → logs exit or error.
// For streaming  : logs entry → wraps next() AsyncIterable → logs per-chunk
//                  lifecycle + logs end/error after the stream closes.
//
// The layer deliberately re-throws errors after logging them so error
// propagation unwinds outward through every enclosing Layer (§8.1 rule 2).
// ---------------------------------------------------------------------------

function makeLayer(rootLogger: Logger) {
  return function loggerLayer(
    call: Call,
    next: Next,
  ): Promise<Result> | AsyncIterable<Chunk> {
    const log = getOrInsertLogger(call, rootLogger);
    const op = call.operation.id;
    const t = Date.now();

    log.info({ op }, `→ ${op}`);

    // Invoke the continuation and branch on whether it returns a stream.
    const downstream = next();

    // Helper: check for AsyncIterable (streaming §11)
    function isAsyncIterable(v: unknown): v is AsyncIterable<Chunk> {
      return (
        v !== null &&
        typeof v === 'object' &&
        Symbol.asyncIterator in (v as object)
      );
    }

    if (isAsyncIterable(downstream)) {
      // --- Streaming path (§11) ---
      // Wrap the iterable: log per-chunk, log end/error after stream closes.
      return (async function* streamWrapper(): AsyncIterable<Chunk> {
        let chunks = 0;
        try {
          for await (const chunk of downstream) {
            chunks++;
            log.debug({ op, chunk: chunks }, `chunk ${chunks}`);
            yield chunk;
          }
          log.info({ op, ms: Date.now() - t, chunks }, `← ${op} ok`);
        } catch (e) {
          log.error({ op, ms: Date.now() - t, err: e }, `✗ ${op} stream error`);
          throw e; // §8.1 rule 2 — unwind outward
        }
      })();
    }

    // --- Unary path ---
    // `downstream` is a Promise<Result>.
    return (downstream as Promise<Result>).then(
      (r) => {
        log.info({ op, ms: Date.now() - t }, `← ${op} ok`);
        return r;
      },
      (e: unknown) => {
        log.error({ op, ms: Date.now() - t, err: e }, `✗ ${op} error`);
        throw e; // §8.1 rule 2 — unwind outward
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * v2 logger plugin (SPEC §7.2a / SPEC §8.1).
 *
 * Implements the `layer` capability only — it wraps every operation, logs
 * entry/exit/error, and is stream-lifecycle aware (SPEC §11).
 *
 * Also seeds the per-request {@link Logger} into `call.ctx` so downstream
 * layers and domain functions can read it via `call.ctx.get(Logger)`.
 *
 * The `target` capability is retained as a pass-through scaffold so the plugin
 * can still be selected via `--type logger` without errors; it emits no files.
 */
export const loggerPlugin: Plugin<LoggerOptions> = {
  id: 'logger',
  description:
    'Layer plugin: wraps every operation with entry/exit/error logging (SPEC §7.2a / §8.1). Seeds Logger into call.ctx for downstream consumers.',
  language: 'ts',

  optionsSchema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        description: 'pino log level (trace|debug|info|warn|error|fatal). Default: info.',
        default: 'info',
      },
      format: {
        type: 'string',
        enum: ['json', 'pretty'],
        description:
          'Log output format. Default: pretty on a TTY stderr, json otherwise.',
      },
      destination: {
        type: 'string',
        description:
          'File path to write logs to. Default: stderr (fd 2). Never stdout.',
      },
    },
  },

  capabilities: {
    // ------------------------------------------------------------------
    // target — retained as a no-op scaffold (generate-only, no serve).
    //          The logger plugin does not project descriptor operations to
    //          files; this block ensures `--type logger` does not throw.
    // ------------------------------------------------------------------
    target: {
      name: 'logger',

      generate(_descriptor: Descriptor, _opts: LoggerOptions): File[] {
        // Logger is a layer-only plugin — no files emitted.
        return [];
      },
    },

    // ------------------------------------------------------------------
    // layer — the operative capability (SPEC §7.1 / §8 / §8.1 / §11).
    //
    // The layer function is built lazily on first call so opts (log level,
    // format, destination) resolved at compose time are baked into the
    // root logger instance.  For simplicity the default export uses the
    // module-level `_defaultRoot` logger.  Consumers that need per-request
    // option control should construct a plugin instance via `makeLoggerPlugin`.
    // ------------------------------------------------------------------
    layer: {
      layer: makeLayer(_defaultRoot),
    },
  },
};

/**
 * Factory that returns a fully-configured logger plugin instance.
 *
 * Use this when you need per-deployment log level, format, or destination
 * control at compose time rather than relying on the default export's
 * built-in json/stderr defaults.
 *
 * @example
 * ```ts
 * import { makeLoggerPlugin } from '@adhd/apigen-plugin-logger'
 * const invoke = createInvoker([makeLoggerPlugin({ level: 'debug', format: 'pretty' })])
 * ```
 */
export function makeLoggerPlugin(opts: LoggerOptions = {}): Plugin<LoggerOptions> {
  const root = buildRootLogger(opts);
  return {
    ...loggerPlugin,
    capabilities: {
      ...loggerPlugin.capabilities,
      layer: {
        layer: makeLayer(root),
      },
    },
  };
}

export default loggerPlugin;
