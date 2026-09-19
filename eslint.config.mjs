import baseConfig from './eslint.base.config.mjs';

/**
 * Workspace-root flat config.
 *
 * The shared rule set lives in `eslint.base.config.mjs`; each project's
 * `eslint.config.mjs` imports that same file, so the workspace rules apply to
 * every project. This root entry exists so files that live at the workspace root
 * (and any project without its own config) resolve to the same rules.
 */
export default [...baseConfig];
