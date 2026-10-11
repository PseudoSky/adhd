// @adhd/agent-core-native-tooling — resolver + thin permission matcher for the
// standardized, portable native toolset (ADR-0008). CommonJS-only (adhd ADR-0003).
//
// This package owns ONLY:
//   - resolution of the builtin fs/shell/dispatch servers against a task-time cwd;
//   - tool-NAME permission matching (last-match-wins, `deny` terminal).
// It owns NO command parser, NO command segmentation, and NO dangerous-command
// catalog — hard enforcement is delegated to the adopted servers and `srt` (D5/D7).

export {
  NativeToolingRootError,
  resolveNativeTooling,
  resolveNativeToolingMap,
  resolveFsRoots,
  resolveShellRoot,
} from './lib/resolver.js';
export type { NativeResolveContext, ResolvedNativeServer } from './lib/resolver.js';

export { matchPermission } from './lib/permissions.js';

// Line-ending preservation for the adopted fs server's LF normalization (8dd148cf).
export { classifyEol, restoreLineEndings } from './lib/eol.js';
export type { EolClass } from './lib/eol.js';

export {
  NATIVE_TOOL_NAMES,
  NATIVE_SERVER_CATALOG,
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  resolveFsServerLaunch,
  SHELL_PROXY_ENV_KEYS,
  SHELL_SERVER,
  SRT_SANDBOX,
  wrapWithSandbox,
} from './lib/catalog.js';
export type {
  NativeToolName,
  NativeServerCatalogEntry,
  WrappableCommand,
} from './lib/catalog.js';

// The ONE producer of the agent-mcp self (`dispatch` member) launch config (A2).
export {
  buildDispatchSelf,
  DISPATCH_SELF_COMMAND_ENV,
  DISPATCH_SELF_ARGS_ENV,
  DISPATCH_SELF_COMMAND_ENV_LEGACY,
  DISPATCH_SELF_ARGS_ENV_LEGACY,
  DISPATCH_SELF_DEFAULT_ARGS,
} from './lib/dispatch-self.js';
