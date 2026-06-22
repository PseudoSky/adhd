import pino from 'pino'
import type { Logger, LoggerOptions } from 'pino'

export type { Logger }

/** Log output format. `pretty` is colorized human-readable; `json` is raw jsonl. */
export type LogFormat = 'json' | 'pretty'

export interface CreateLoggerOptions {
  /** pino log level. Default: `info`. */
  level?: string
  /**
   * Output format. Default: `pretty` when the destination is a TTY, else `json`.
   * `pretty` routes through pino-pretty (colorized, timestamped); `json` emits jsonl.
   */
  format?: LogFormat
  /**
   * Where logs are written. Default: stderr (fd 2) — NEVER stdout, which is the
   * MCP stdio JSON-RPC channel. Pass a filesystem path to write logs to a file.
   */
  destination?: string
}

/**
 * Build the shared apigen pino logger.
 *
 * Logging always targets stderr or a file — never stdout — so the MCP stdio
 * transport's JSON-RPC channel on stdout stays free of log noise.
 *
 * @param opts - level, format (`json` | `pretty`), and destination (stderr or a file path).
 * @returns a configured pino {@link Logger}.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? 'info'
  const toFile = typeof opts.destination === 'string' && opts.destination.length > 0

  // Default format: pretty on an interactive stderr TTY, json otherwise.
  const isTty = !toFile && Boolean(process.stderr.isTTY)
  const format: LogFormat = opts.format ?? (isTty ? 'pretty' : 'json')

  const options: LoggerOptions = { level }

  if (format === 'pretty') {
    // pino-pretty runs in a worker thread (pino transport). When a file is the
    // destination we let pino-pretty write the file so colorless pretty output
    // lands there; otherwise it colorizes to stderr (fd 2).
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: !toFile,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        ...(toFile ? { destination: opts.destination, mkdir: true } : { destination: 2 }),
      },
    }
    return pino(options)
  }

  // json: raw jsonl. File destination via pino.destination, else fd 2 (stderr).
  const dest = toFile
    ? pino.destination({ dest: opts.destination, mkdir: true, sync: true })
    : pino.destination(2)
  return pino(options, dest)
}
