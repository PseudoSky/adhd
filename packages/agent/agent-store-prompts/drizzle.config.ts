import { defineConfig } from 'drizzle-kit';

import { resolveRegistryDbPath } from '@adhd/agent-core-env';

export default defineConfig({
  dialect: 'sqlite',

  schema: './src/db/schema.ts',

  out: './drizzle',

  dbCredentials: {
    // Precedence (highest→lowest): ADHD_AGENT_REGISTRY_DB_PATH →
    // REGISTRY_DATABASE_PATH → DATABASE_PATH → the @adhd/environment-resolved
    // canonical default (~/.adhd/agent-registry/production/data/registry.db).
    // See @adhd/agent-core-env's resolveRegistryDbPath() — synchronous, no
    // I/O prerequisite, safe to call from this non-async drizzle-kit config.
    url: resolveRegistryDbPath(),
  },

  verbose: true,

  strict: true,
});
