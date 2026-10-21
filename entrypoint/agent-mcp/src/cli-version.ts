/**
 * The published package version, read the same way `server.ts` reads it: one level
 * above `src/` (or `dist/src/`) is the package root's `package.json`. The bundler
 * inlines this JSON at build time, so the bundled bins report the same version.
 */
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** The agent-mcp package version every bin reports for `--version`. */
export const CLI_VERSION: string = (
  _require("../package.json") as { version: string }
).version;
