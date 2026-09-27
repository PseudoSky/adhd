/**
 * service-errors.ts — the typed failures D-A introduces at the PROCESS,
 * CONFIG and RESILIENCE seams (see `service-config.ts`, `lifecycle.ts`,
 * `retry-policy.ts`).
 *
 * Every class here extends {@link BacklogWriteError} so it rides the SAME
 * closed error taxonomy the write layer already uses (`E_VALIDATION`, never
 * retryable) rather than inventing a second failure vocabulary. They are
 * thrown at startup / config-validation / reconnect time, not from inside a
 * store transaction, but the transport-facing contract is identical: a
 * caller can switch on the class, never a message string.
 */
import { BacklogWriteError } from './write/errors.js';

/** An unknown key under the `service.*` config subtree in a layer file. */
export class UnknownConfigKeyError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  /** The offending key, WITHOUT the `service.` prefix (e.g. `bogusKey`). */
  readonly key: string;
  /** The absolute layer file the key was found in. */
  readonly file: string;

  constructor(key: string, file: string) {
    super(
      `Unknown config key "service.${key}" in ${file}. ` +
        `An unknown key is a hard error (a host would otherwise silently ` +
        `ignore it). Known keys are the service.* contract — see ` +
        `SERVICE_CONFIG_KEYS / the backlog docs.`
    );
    this.key = key;
    this.file = file;
  }
}

/** A path-valued config field that is neither absolute nor a PATH bin. */
export class NonAbsolutePathError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  readonly field: string;
  readonly value: string;

  constructor(field: string, value: string) {
    super(
      `Config field "${field}" must be an absolute path (or a PATH-resolvable ` +
        `bin such as "npx"/"node"), got "${value}". A relative path resolves ` +
        `against an unpredictable cwd and is refused.`
    );
    this.field = field;
    this.value = value;
  }
}

/** An unknown key inside a host MCP server entry (the `environment` vs `env`
 *  silent no-op is the exact failure this prevents). */
export class UnknownMcpConfigKeyError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  /** The host config file the entry lives in. */
  readonly entry: string;
  readonly key: string;
  /** Closest allowed key, when one is close enough to suggest. */
  readonly suggestion?: string;

  constructor(entry: string, key: string, suggestion?: string) {
    super(
      `Unknown MCP config key "${key}" in ${entry}` +
        (suggestion ? ` (did you mean "${suggestion}"?)` : '') +
        `. Allowed keys are type/command/args/env/url. An unknown key is a ` +
        `HARD ERROR: a host silently ignores it, so a server "configured" with ` +
        `it looks configured and is absent.`
    );
    this.entry = entry;
    this.key = key;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

/** The configured server artifact is missing, non-executable, or its content
 *  identity does not match what was installed. */
export class ArtifactDriftError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  readonly expected: string;
  readonly actual: string;
  readonly resolvedPath: string;

  constructor(expected: string, actual: string, resolvedPath: string) {
    super(
      `Server artifact drift at ${resolvedPath}: expected ${expected}, got ${actual}. ` +
        `Refusing to start — a config pointing at a missing or changed ` +
        `artifact must fail loudly, not launch a phantom.`
    );
    this.expected = expected;
    this.actual = actual;
    this.resolvedPath = resolvedPath;
  }
}

/** A readiness/liveness failure surfaced by the resilience layer (a bounded
 *  budget was exhausted, or the breaker refused the attempt). */
export class ServiceNotReadyError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = true;
  readonly state: string;
  readonly failure?: string;

  constructor(state: string, failure?: string) {
    super(
      `Service not ready (state=${state})` +
        (failure ? `: ${failure}` : '') +
        `. The connect/handshake did not succeed inside its bounded budget.`
    );
    this.state = state;
    if (failure !== undefined) this.failure = failure;
  }
}
