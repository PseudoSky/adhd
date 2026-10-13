import { access, readFile, writeFile } from 'node:fs/promises';

/** File access port for `.mcp.json` handling; the only place these verbs touch the disk. */
export interface IMcpJsonFs {
  /** Resolves `undefined` when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** The real filesystem. Text is read and written as UTF-8 with no normalisation, so a copy is byte-exact. */
export const nodeMcpJsonFs: IMcpJsonFs = {
  async read(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async write(path, text) {
    await writeFile(path, text, 'utf8');
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** Where `init` keeps the original. */
export function backupPath(file: string): string {
  return `${file}.adhd-policy.bak`;
}
