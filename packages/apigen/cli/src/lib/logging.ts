import { Command } from 'commander'
import { createLogger } from '@adhd/apigen-runtime'
import type { Logger, LogFormat } from '@adhd/apigen-runtime'

export interface LoggingFlags {
  logLevel?: string
  logFormat?: string
  logFile?: string
}

/** Add program-level logging options. Env vars provide fallbacks at build time. */
export function addLoggingOptions(program: Command): Command {
  return program
    .option('--log-level <level>', 'Log level: trace|debug|info|warn|error|fatal|silent (env APIGEN_LOG_LEVEL)')
    .option('--log-format <format>', 'Log format: json|pretty (env APIGEN_LOG_FORMAT)')
    .option('--log-file <path>', 'Write logs to a file instead of stderr (env APIGEN_LOG_FILE)')
}

/**
 * Build the shared CLI logger from program-level flags, falling back to env
 * vars (`APIGEN_LOG_LEVEL`, `APIGEN_LOG_FORMAT`, `APIGEN_LOG_FILE`). Flags win
 * over env. Logs target stderr (or `--log-file`) — never stdout.
 */
export function buildCliLogger(program: Command): Logger {
  const opts = program.opts<LoggingFlags>()
  const level = opts.logLevel ?? process.env['APIGEN_LOG_LEVEL'] ?? 'info'
  const rawFormat = opts.logFormat ?? process.env['APIGEN_LOG_FORMAT']
  const format: LogFormat | undefined =
    rawFormat === 'json' || rawFormat === 'pretty' ? rawFormat : undefined
  const destination = opts.logFile ?? process.env['APIGEN_LOG_FILE']
  return createLogger({ level, format, destination })
}
