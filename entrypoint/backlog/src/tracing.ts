import { makeTracingPlugin } from '@adhd/apigen-plugin-tracing';

/**
 * The ONE configured tracing plugin for every `@adhd/backlog` transport (fastify, mcp, cli).
 *
 * `serviceName` is the emitted span/record/attribute namespace. It is REQUIRED by the plugin —
 * there is no implicit default — and here it is `'adhd'` because backlog is an adhd product.
 * The plugin's own `tracingPlugin` singleton is apigen-namespaced and must NOT be imported by
 * this package; every mount references THIS instance so all three transports share one
 * `adhd.*` namespace (and one identity, asserted by `server.tracing-required.spec.ts`).
 */
export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' });
