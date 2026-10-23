import { Environment } from '@adhd/environment';
import type { EnvironmentOptions, EnvironmentSpec } from '@adhd/environment-base-spec';

/** Resolved operational settings (spec 10.2). Layer files are data; these are knobs. */
export interface IPolicyConfig {
  /** Explicit layer file override (flag/env): comma-separated paths, by position global, project, local. */
  readonly policy: { readonly files: string | undefined };
  readonly ask: { readonly timeoutMs: number };
  readonly logging: { readonly level: string };
}

/**
 * The `@adhd/environment` spec for the policy tooling. The `dirs` kinds
 * `config`, `cache` and `logs` and the `files` entries `{ in, name }` are
 * accepted by `EnvironmentSpec` exactly as written in spec 10.2 (verified
 * against `entrypoint/backlog/src/env.ts`, which uses the same shapes).
 * `production` stays first: the resolver falls back to the first namespace.
 */
export const policyEnvironmentSpec: EnvironmentSpec<IPolicyConfig> = {
  envPrefixOverride: 'ADHD_POLICY',
  namespaces: ['production', 'test'],
  dirs: {
    config: { kind: 'config' },
    cache: { kind: 'cache' },
    logs: { kind: 'logs' },
  },
  files: {
    global: { in: 'config', name: 'global.yaml' },
    local: { in: 'config', name: 'local.yaml' },
  },
  config: {
    'policy.files': {
      type: 'string',
      env: 'ADHD_POLICY_FILES',
      description: 'Explicit policy layer files (comma-separated, by position global, project, local). Wins over discovery.',
    },
    'ask.timeoutMs': {
      type: 'integer',
      env: 'ADHD_POLICY_ASK_TIMEOUT_MS',
      default: 60000,
      description: 'How long a host waits for an answer to an `ask` decision (ms).',
    },
    'logging.level': {
      type: 'string',
      env: 'ADHD_POLICY_LOG_LEVEL',
      default: 'info',
      enum: ['debug', 'info', 'warn', 'error', 'silent'],
    },
  },
};

/**
 * Builds the policy `Environment`. `namespace` defaults to `production`;
 * `projectRoot` becomes the environment `cwd` (the project marker search
 * starts there). Nothing is derived from `process.cwd()` by this function.
 */
export function buildPolicyEnv(options: { namespace?: 'production' | 'test'; projectRoot?: string } = {}): Environment<IPolicyConfig> {
  const envOptions: EnvironmentOptions = { namespace: options.namespace ?? 'production' };
  if (options.projectRoot !== undefined) envOptions.cwd = options.projectRoot;
  return new Environment<IPolicyConfig>('policy', policyEnvironmentSpec, envOptions);
}

export type { Environment };
