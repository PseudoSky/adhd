import AdmZip from 'adm-zip';
import fse from 'fs-extra';
import _ from 'lodash';
import path from 'path';
import formatDates from '../formatters/dates.js';
import { buildPackage, cruiseDeps, getDeps } from './package.js';
import { BABELRC, BLANK_PACKAGE } from './templates.js';
import { cleanFilePath, isExternalRef } from './utils.js';

export interface WriteOperations {
  pending: Promise<any>[];
  completed: string[];
}

interface IStore {
  writes: WriteOperations;
  zip: AdmZip;
  prefix: string;
  main_file: string;
}

class FileStore implements IStore {
  static buildPackage = buildPackage;
  static getDeps = getDeps;
  static cruiseDeps = cruiseDeps;
  public index: Record<string, Record<string, number>> = {
    pending: {},
    completed: {},
    main: {},
  };
  public writes: WriteOperations = {
    pending: [],
    completed: [],
  };
  public zip: AdmZip;
  public prefix: string;
  public main_file: string;

  constructor(initialPrefix: string = './build/reverse') {
    this.zip = new AdmZip();
    this.prefix = initialPrefix;
    this.main_file = '';
  }

  public setPrefix(prefix_path: string, timestamp: boolean = true): void {
    this.prefix = `${prefix_path}/${timestamp ? formatDates() : ''}/src`;
  }

  public pathFor(file: string): string {
    return path.join(this.prefix, cleanFilePath(file));
  }

  public pending(): Promise<any>[] {
    return this.writes.pending;
  }

  public completed(): string[] {
    return this.writes.completed;
  }

  public count(event: keyof WriteOperations): number {
    return this.writes[event].length;
  }

  private log(event: keyof WriteOperations, data: any): void {
    this.writes[event].push(data);
  }

  public addFile(file: string, content: string | Buffer, type: 'dir' | 'zip' = 'dir'): Promise<void> | null {
    const outfile = this.pathFor(file);

    if (isExternalRef(outfile)) {
      return null;
    }

    if (type === 'zip') {
      if (this.index.pending[outfile]) {
        this.index.pending[outfile] = ((this.index.pending[outfile] || 0) + 1)
        return Promise.resolve();
      }
      const buffer = Buffer.from(content as string, 'utf-8');
      const p = this.zip.addFile(outfile, buffer);
      this.log('pending', p);
      return Promise.resolve();
    }
    if (this.index.completed[outfile]) {
      this.index.completed[outfile] = ((this.index.completed[outfile] || 0) + 1)
      return Promise.resolve();
    }
    const p = fse.outputFile(outfile, content)
      .then(() => this.log('completed', outfile))
      .catch((err) => {
        console.error('Failed to write file:', err);
      });

    this.log('pending', p);
    return p;
  }

  public addToImports(filePath: string): void {
    const parts = filePath.split('.');
    parts.pop();
    const base = parts.join('.');

    if (!this.index.main[filePath] && (base.endsWith('index') &&
      !base.includes('node_modules') &&
      !base.includes('webpack'))) {
      this.main_file += `import ${_.camelCase(path.dirname(filePath))} from "./${filePath}"\n`;
      this.index.main[filePath] = 1;
    }
  }

  public async flush(): Promise<any[]> {
    const results = await Promise.all(this.pending());
    this.writes = {
      pending: [],
      completed: [],
    };
    return results;
  }

  public async finalize(): Promise<WriteOperations> {
    try {
      await this.addFile('package.json', JSON.stringify(BLANK_PACKAGE, null, 4));
      await this.addFile('.babelrc', JSON.stringify(BABELRC, null, 4));
      await this.flush();
      await this.addFile('index.js', this.main_file);

      const deps = await buildPackage(this.prefix, {});
      const uniqueDeps = _.uniq(deps).map((p) => ({ [p]: '*' }));
      BLANK_PACKAGE.dependencies = Object.assign({}, ...uniqueDeps);

      const packageJson = JSON.stringify(BLANK_PACKAGE, null, 4);
      await this.addFile('package.json', packageJson);
      await this.flush();
    } catch (error) {
      console.error('Failed to finalize store:', error);
    }
    return this.writes;
  }
}

// Create singleton instance
const Store = new FileStore();

// Add static methods for backward compatibility
// Store.buildPackage = buildPackage;
// Store.getDeps = getDeps;
// Store.cruiseDeps = cruiseDeps;

export { FileStore, Store };
export default Store;
