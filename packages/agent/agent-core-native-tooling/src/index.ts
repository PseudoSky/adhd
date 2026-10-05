// @adhd/agent-core-native-tooling — resolver + thin permission matcher for the
// standardized, portable native toolset (ADR-0008). CommonJS-only (adhd ADR-0003).
//
// This package owns ONLY:
//   - resolution of the builtin fs/shell/dispatch servers against a task-time cwd;
//   - tool-NAME permission matching (last-match-wins, `deny` terminal).
// It owns NO command parser, NO command segmentation, and NO dangerous-command
// catalog — hard enforcement is delegated to the adopted servers and `srt` (D5/D7).

export { resolveNativeTooling } from './lib/resolver.js';
export type { NativeResolveContext } from './lib/resolver.js';

export { matchPermission } from './lib/permissions.js';

export {
  NATIVE_TOOL_NAMES,
  NATIVE_SERVER_CATALOG,
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  SHELL_SERVER,
} from './lib/catalog.js';
export type { NativeToolName, NativeServerCatalogEntry } from './lib/catalog.js';
