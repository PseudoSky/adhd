/**
 * migrate.ts — Schema version migration for dag.json documents.
 */
interface MigrationStep {
  from: number;
  to: number;
  apply: (dag: Record<string, unknown>) => void;
}

const MIGRATIONS: MigrationStep[] = [
  {
    from: 2,
    to: 3,
    apply: (dag) => {
      if (!dag['milestones'] && dag['nodes']) {
        dag['milestones'] = dag['nodes'];
        delete dag['nodes'];
      }
      const ops = dag['operations'];
      if (ops && typeof ops === 'object' && !Array.isArray(ops))
        dag['operations'] = Object.values(ops as Record<string, unknown>);
    },
  },
  {
    from: 3,
    to: 4,
    apply: (dag) => {
      if (
        !dag['providers'] ||
        Object.keys(dag['providers'] as object).length === 0
      )
        dag['providers'] = {
          Haiku: {
            type: 'claudecli',
            model_id: 'claude-haiku-4-5',
            env_secret: null,
            base_url: null,
            timeout_ms: 60000,
            retry_config: {
              retries: 3,
              min_timeout: 1000,
              max_timeout: 30000,
              factor: 2,
            },
          },
          Sonnet: {
            type: 'claudecli',
            model_id: 'claude-sonnet-4-5',
            env_secret: null,
            base_url: null,
            timeout_ms: 120000,
            retry_config: {
              retries: 3,
              min_timeout: 1000,
              max_timeout: 30000,
              factor: 2,
            },
          },
          Opus: {
            type: 'claudecli',
            model_id: 'claude-opus-4-5',
            env_secret: null,
            base_url: null,
            timeout_ms: 300000,
            retry_config: {
              retries: 3,
              min_timeout: 1000,
              max_timeout: 30000,
              factor: 2,
            },
          },
        };
      if (
        !dag['effort_max_tokens'] ||
        Object.keys(dag['effort_max_tokens'] as object).length === 0
      )
        dag['effort_max_tokens'] = {
          low: 1024,
          medium: 4096,
          high: 8192,
          xhigh: 16384,
          max: 32768,
        };
      if (!dag['optimization'])
        dag['optimization'] = {
          sentinel_fanout: {
            enabled: true,
            write_multiplier: 1.25,
            read_multiplier: 0.1,
            hit_probability: 0.9,
          },
          b_per_tier: { Haiku: 8000, Sonnet: 15000, Opus: 27000 },
          context_window_per_tier: { Haiku: 16000, Sonnet: 16000, Opus: 32000 },
          context_window_override: null,
          b_override: null,
        };
      let ops: unknown[] = [];
      if (Array.isArray(dag['operations'])) {
        ops = dag['operations'] as unknown[];
      } else if (dag['operations'] && typeof dag['operations'] === 'object') {
        ops = Object.values(dag['operations'] as Record<string, unknown>);
      }
      for (const op of ops) {
        if (typeof op === 'object' && op !== null) {
          const o = op as Record<string, unknown>;
          if (o['type'] === undefined) o['type'] = 'generative';
          if (o['criteria'] === undefined) o['criteria'] = [];
          if (o['tool'] === undefined) o['tool'] = null;
          if (o['args'] === undefined) o['args'] = null;
        }
      }
    },
  },
];

export function migrateDag(
  fromVersion: number,
  toVersion: number,
  dag: Record<string, unknown>
): void {
  if (fromVersion === toVersion) return;
  let current = fromVersion;
  for (const step of [...MIGRATIONS].sort((a, b) => a.from - b.from)) {
    if (step.from === current) {
      step.apply(dag);
      current = step.to;
      if (current === toVersion) {
        dag['schema_version'] = toVersion;
        return;
      }
    }
  }
  throw new Error(
    `migrateDag: no path from v${fromVersion} to v${toVersion}. Available: [${MIGRATIONS.map(
      (m) => `v${m.from}→v${m.to}`
    ).join(', ')}]`
  );
}
