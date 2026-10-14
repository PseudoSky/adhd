import { makeTracingPlugin } from '@adhd/apigen-plugin-tracing';

/** One span per dispatched operation on every transport (IN-15). */
export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd-policy' });
