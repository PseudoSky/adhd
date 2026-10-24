/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * The e2e lane of `resilience-core-tripwire`: runs ONLY `test/e2e/**\/*.e2e.ts`, the real-disk run of the
 * TripwireStorage contract. Invoked with `nx run resilience-core-tripwire:e2e`. The lane mechanics live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
