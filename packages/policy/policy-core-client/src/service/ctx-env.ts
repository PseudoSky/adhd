import type { IAuditSink, IRuntimeProvider } from '../spec';
import type { Environment, IPolicyConfig } from './config/env-spec';
import { createFsLayerSource } from './config/layer-source';
import { createCtx } from './ctx';
import type { IPolicyCtx } from './ctx';

const SETTING_KEYS = ['policy.files', 'ask.timeoutMs', 'logging.level'] as const;

function read(config: IPolicyConfig, key: (typeof SETTING_KEYS)[number]): unknown {
  switch (key) {
    case 'policy.files':
      return config.policy.files;
    case 'ask.timeoutMs':
      return config.ask.timeoutMs;
    default:
      return config.logging.level;
  }
}

/**
 * The only ctx constructor that reads settings: layer files come from
 * `ports.explicit`, else `policy.files`, else discovery (walk-up from
 * `ports.cwd`, plus the environment's `global` / `local` files). Nothing is read
 * until a thunk is awaited. The cwd is a parameter; this function never reads
 * `process.cwd()`, so without `ports.cwd` there is no walk-up.
 */
export function createPolicyCtx(
  env: Environment<IPolicyConfig>,
  ports?: {
    runtime?: IRuntimeProvider;
    audit?: IAuditSink;
    cwd?: string;
    explicit?: readonly string[];
    onSource?: (label: string) => void;
  }
): IPolicyCtx {
  let policySource = 'not loaded yet';
  const fromSetting = env.config.policy.files
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const explicit = ports?.explicit !== undefined && ports.explicit.length > 0 ? ports.explicit : fromSetting;
  const source = createFsLayerSource({
    ...(ports?.cwd !== undefined ? { cwd: ports.cwd } : {}),
    ...(explicit !== undefined && explicit.length > 0 ? { explicit } : {}),
    globalFile: env.files['global'],
    localFile: env.files['local'],
    onSource: (label) => {
      policySource = label.replace(/^policy: /, '');
      ports?.onSource?.(label);
    },
  });
  return createCtx({
    source,
    ...(ports?.runtime !== undefined ? { runtime: ports.runtime } : {}),
    ...(ports?.audit !== undefined ? { audit: ports.audit } : {}),
    describe: () => {
      const settings: Record<string, { value: unknown; source: string }> = {};
      for (const key of SETTING_KEYS) {
        settings[key] = { value: read(env.config, key), source: env.provenance[key]?.source ?? 'default' };
      }
      return { settings, policySource };
    },
  });
}
