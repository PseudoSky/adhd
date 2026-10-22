import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ISourceProbe } from '@adhd/apigen-core-client';

/** True when `path` exists and is a regular file; false on any error. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` carries an exec bit for this process (always true on win32 for a file); false on any error. */
function hasExecBit(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Executable suffixes tried on win32 (`PATHEXT`), lowercased; `['']` elsewhere. */
function pathExtensions(): readonly string[] {
  if (process.platform !== 'win32') return [''];
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...raw.split(';').filter(Boolean).map((e) => e.toLowerCase())];
}

/**
 * The node implementation of the core {@link ISourceProbe} port, consumed by
 * `resolveSourceReference(reference, nodeSourceProbe)`. Synchronous, starts nothing and
 * never spawns `which`; every check answers `false` on any filesystem error.
 *
 * - `isFile(p)`: `p` exists and is a regular file.
 * - `isExecutable(p)`: `p` carries an exec bit for this process (`access(X_OK)`).
 * - `onPath(c)`: `c` is a bare name (no path separator, not absolute) and a regular file
 *   with an exec bit named `c` (plus a `PATHEXT` suffix on win32) exists in a `PATH`
 *   directory. Empty `PATH` entries are ignored rather than read as the current directory.
 */
export const nodeSourceProbe: ISourceProbe = {
  isFile: isRegularFile,
  isExecutable: hasExecBit,
  onPath(command: string): boolean {
    if (command.length === 0 || isAbsolute(command) || /[\\/]/.test(command)) return false;
    const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
    for (const dir of dirs) {
      for (const ext of pathExtensions()) {
        const candidate = join(dir, command + ext);
        if (isRegularFile(candidate) && hasExecBit(candidate)) return true;
      }
    }
    return false;
  },
};
