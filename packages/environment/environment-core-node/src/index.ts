/**
 * `@adhd/environment` — public API surface.
 *
 * The `Environment<T>` runtime client (ARCHITECTURE.md §3), plus the
 * spec-authoring types re-exported from `@adhd/environment-base-spec` so a
 * consumer never needs a direct dependency on that package just to type its
 * `EnvironmentSpec`.
 */
export { Environment, EnvironmentError, LockHeldError, SnapshotNotFoundError } from './environment';
export type {
  DeepPath,
  DirKind,
  DirSpec,
  EnvironmentOptions,
  EnvironmentSpec,
  FieldSpec,
  FieldType,
  FileSpec,
  ProvenanceEntry,
  ProvenanceSource,
  ResolvedDirEntry,
  ResolvedFileEntry,
  Scope,
  Share,
  SnapshotData,
} from '@adhd/environment-base-spec';
