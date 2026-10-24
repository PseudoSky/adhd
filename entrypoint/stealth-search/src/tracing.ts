// Import path: makeTracingPlugin from '@adhd/apigen-plugin-tracing'
// (packages/apigen/apigen-plugin-tracing/src/index.ts; same as entrypoint/backlog/src/tracing.ts).
import { makeTracingPlugin } from '@adhd/apigen-plugin-tracing';

/**
 * The ONE configured tracing plugin for every stealth-search host (cli, mcp).
 * Namespace `adhd` => records `adhd.<op>.start|finish|error`. The plugin
 * package's own `tracingPlugin` singleton (namespace `apigen`) is never imported.
 */
export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' });
