/**
 * Input-safety guards for the `registry-package` generator.
 *
 * The generator has three injection surfaces, all fed from its options:
 *   1. Nx target `command` strings — handed to a shell by `nx:run-commands`;
 *   2. file/directory paths — spliced into the virtual workspace Tree;
 *   3. a `tablePrefix` — stamped into generated SQLite DDL that is executed by
 *      the emitted skeleton test on first run.
 *
 * Every input is therefore validated BEFORE the generator mutates the Tree, so
 * a rejected value never leaves a half-written package behind.
 */

/**
 * kebab-case package name: a lowercase letter-led segment, then any number of
 * `-<alnum>` segments. Admits `budget`, `tool-registry`, `smoke-test-pkg`;
 * rejects uppercase, leading digits, `_`, and any shell/SQL metacharacter.
 */
export const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * A relative, `/`-separated directory path whose every segment is restricted to
 * `[A-Za-z0-9._-]`. The leading negative lookahead rejects `.` and `..`
 * segments outright, so the path can never traverse out of the workspace; the
 * character class keeps out leading slashes and shell metacharacters.
 */
export const DIRECTORY_PATTERN =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * A SQL identifier usable anywhere in generated DDL: letters, digits and
 * underscore, never starting with a digit. Rejects quotes, semicolons and
 * whitespace, so it cannot break out of a quoted identifier or terminate a
 * statement.
 */
export const TABLE_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The fully-computed inputs a `registryPackageGenerator` call is about to use. */
export interface IRegistryPackageInputs {
  /** Raw `name` option (kebab-case, without the `agent-` prefix). */
  name: string;
  /** `names(name).fileName` — the derived package basename. */
  baseName: string;
  /** Resolved target directory (default `packages/agent/agent-<baseName>`). */
  projectDir: string;
  /** Derived build output path (`dist/<projectDir>`). */
  outputPath: string;
  /** Resolved table-name prefix. */
  tablePrefix: string;
}

/**
 * Validate every input that will be spliced into a shell command, a path, or
 * generated SQL, throwing on the first unsafe value. Call this immediately
 * after the values are computed and before any Tree mutation.
 *
 * @param inputs - the computed generator inputs.
 * @throws if `name`/`baseName` are not kebab-case, if `projectDir`/`outputPath`
 *   are not safe relative paths (no traversal, no shell metacharacters), or if
 *   `tablePrefix` is not a valid SQL identifier.
 */
export function assertSafeRegistryPackageInputs(
  inputs: IRegistryPackageInputs
): void {
  const { name, baseName, projectDir, outputPath, tablePrefix } = inputs;

  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `registry-package: 'name' (${JSON.stringify(
        name
      )}) must be kebab-case matching ${NAME_PATTERN}`
    );
  }

  if (!NAME_PATTERN.test(baseName)) {
    throw new Error(
      `registry-package: derived package name (${JSON.stringify(
        baseName
      )}) is not kebab-case matching ${NAME_PATTERN}`
    );
  }

  if (!DIRECTORY_PATTERN.test(projectDir)) {
    throw new Error(
      `registry-package: 'directory' (${JSON.stringify(
        projectDir
      )}) must be a relative path of safe segments with no traversal`
    );
  }

  if (!DIRECTORY_PATTERN.test(outputPath)) {
    throw new Error(
      `registry-package: derived output path (${JSON.stringify(
        outputPath
      )}) is not a safe relative path`
    );
  }

  if (!TABLE_PREFIX_PATTERN.test(tablePrefix)) {
    throw new Error(
      `registry-package: 'tablePrefix' (${JSON.stringify(
        tablePrefix
      )}) must be a valid SQL identifier (letters, digits, underscore; not starting with a digit)`
    );
  }
}
