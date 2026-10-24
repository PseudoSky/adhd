/**
 * @adhd/stealth-search: src/host-errors.ts
 *
 * The typed errors of the two hosts (the CLI `stealth-search` and the MCP server
 * `stealth-search-mcp`) and their one rendering. Every host failure is a `StealthSearchError`
 * subclass with a stable code:
 *
 *  - `HOST_FLAG_INVALID`          a host flag or an operation argument has a bad value or name;
 *  - `HOST_TRANSPORT_UNSUPPORTED` the MCP transport is not stdio, sse or streaming-http;
 *  - `HOST_BOOT_FAILED`           the host could not start, or an operation produced no output.
 *
 * `NODE_TOO_OLD` is owned by the core registry and reused here (`nodeTooOldError`).
 *
 * Rendering: the CLI writes `<CODE>: <message>` on ONE stderr line (never a stack) and exits with
 * `exitCodeFor(code)`; the MCP host answers a typed failure as a tool result with `isError: true`
 * whose text is `<canonical>: <CODE>: <message>` (`withMcpErrorChannel`). `renderHostError` and
 * `hostExitCode` are the only places that decide the CLI forms.
 *
 * Inventory rows: I-33 (boot), I-34 (transports), I-36 (CLI one-shot).
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.10]
 */
import { StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import { StealthSearchError, exitCodeFor, isSearchErrorCode, searchError } from './errors.js'
import type { SearchErrorCode, StealthSearchErrorInit } from './errors.js'

/** A host flag or an operation argument that is unknown, missing or has a bad value. */
export class HostFlagInvalidError extends StealthSearchError {
  constructor(message: string, init: StealthSearchErrorInit = {}) {
    super('HOST_FLAG_INVALID', message, init)
    this.name = 'HostFlagInvalidError'
  }
}

/** An MCP transport the host does not serve. */
export class HostTransportUnsupportedError extends StealthSearchError {
  constructor(message: string, init: StealthSearchErrorInit = {}) {
    super('HOST_TRANSPORT_UNSUPPORTED', message, init)
    this.name = 'HostTransportUnsupportedError'
  }
}

/** The host could not boot, or an operation ended without an answer. */
export class HostBootFailedError extends StealthSearchError {
  constructor(message: string, init: StealthSearchErrorInit = {}) {
    super('HOST_BOOT_FAILED', message, init)
    this.name = 'HostBootFailedError'
  }
}

/** A HOST_FLAG_INVALID naming the flag, with the remediation appended. */
export function flagInvalid(flag: string, problem: string, detail: Record<string, unknown> = {}): HostFlagInvalidError {
  const e = searchError('HOST_FLAG_INVALID', `${flag}: ${problem}`, { detail: { flag, ...detail } })
  return new HostFlagInvalidError(e.message, { detail: e.detail })
}

/** A HOST_TRANSPORT_UNSUPPORTED naming the transport and the supported ones. */
export function transportUnsupported(transport: string, supported: readonly string[]): HostTransportUnsupportedError {
  const e = searchError('HOST_TRANSPORT_UNSUPPORTED', `transport "${transport}" is not supported (use ${supported.join(', ')})`, { detail: { transport, supported: [...supported] } })
  return new HostTransportUnsupportedError(e.message, { detail: e.detail })
}

/** A HOST_BOOT_FAILED with the cause attached. */
export function bootFailed(summary: string, cause?: unknown, detail: Record<string, unknown> = {}): HostBootFailedError {
  const e = searchError('HOST_BOOT_FAILED', summary, { detail })
  return new HostBootFailedError(e.message, { ...(cause === undefined ? {} : { cause }), detail: e.detail })
}

/** A NODE_TOO_OLD (core-owned code) for a runtime older than the supported floor. */
export function nodeTooOldError(version: string): StealthSearchError {
  return searchError('NODE_TOO_OLD', `Node.js ${version} is too old; stealth-search needs Node.js 22.5 or newer`, { detail: { version } })
}

/** Any thrown value as a typed search error: a typed error stays itself, anything else becomes HOST_BOOT_FAILED. */
export function asHostError(e: unknown): StealthSearchError {
  if (e instanceof StealthSearchError) return e
  if (e !== null && typeof e === 'object' && isSearchErrorCode((e as { code?: unknown }).code)) {
    const t = e as { code: SearchErrorCode; message?: unknown; detail?: Record<string, unknown> }
    return new StealthSearchError(t.code, typeof t.message === 'string' ? t.message : String(t.code), { cause: e, ...(t.detail ? { detail: t.detail } : {}) })
  }
  const message = e instanceof Error ? e.message : String(e)
  return bootFailed(`unexpected failure: ${message}`, e)
}

/** The one stderr line of a host failure: `<CODE>: <message>`. Newlines in the message become spaces. */
export function renderHostError(e: unknown): string {
  const err = asHostError(e)
  return `${err.code}: ${err.message.replace(/\s*\r?\n\s*/g, ' ')}`
}

/** The process exit status of a host failure (`exitCodeFor` of its code). */
export function hostExitCode(e: unknown): number {
  return exitCodeFor(asHostError(e).code)
}

// ─── The MCP error channel ────────────────────────────────────────────────────

/** Typed codes that blame the caller's input; every other typed code is an `internal` failure. */
const INVALID_ARGUMENT_CODES: ReadonlySet<string> = new Set(['UNKNOWN_PROVIDER', 'HOST_FLAG_INVALID', 'FETCH_URL_REFUSED'])

/**
 * A typed failure in the form the apigen MCP plugin turns into a tool result (ADR-0018 D2). A
 * `StealthCoreBrowserError` cannot extend apigen's `ApiError` (it already extends the core error), so
 * this carrier has the structural shape the plugin tests (`name` 'ApiError', a canonical `code`, `toJSON`);
 * the stable library code travels as the first token of the message and in `details.code`.
 */
export class McpToolError extends Error {
  readonly code: 'invalid_argument' | 'internal'
  readonly details: { code: string; remediation: string; detail?: Record<string, unknown> }
  readonly cause: StealthCoreBrowserError

  constructor(source: StealthCoreBrowserError) {
    const code = String(source.code)
    super(`${code}: ${source.message}`)
    this.cause = source
    this.name = 'ApiError'
    this.code = INVALID_ARGUMENT_CODES.has(code) ? 'invalid_argument' : 'internal'
    this.details = { code, remediation: source.remediation, ...(source.detail ? { detail: source.detail } : {}) }
  }

  toJSON(): { code: string; message: string; details: McpToolError['details'] } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** A typed library or search failure as an `McpToolError`; anything else is returned as is (the plugin re-throws it as a protocol error). */
export function toMcpToolError(e: unknown): unknown {
  return e instanceof StealthCoreBrowserError ? new McpToolError(e) : e
}

/** The live functions of a package with every typed failure mapped by `toMcpToolError`. */
export function withMcpErrorChannel<P extends { fns?: Record<string, (...args: unknown[]) => unknown> }>(pkg: P): P {
  if (!pkg.fns) return pkg
  const fns: Record<string, (...args: unknown[]) => unknown> = {}
  for (const [name, fn] of Object.entries(pkg.fns)) {
    fns[name] = async (...args: unknown[]) => {
      try {
        return await fn(...args)
      } catch (e) {
        throw toMcpToolError(e)
      }
    }
  }
  return { ...pkg, fns }
}
