/**
 * Shared scaffold for the c536ce29 P2 e2e suites (TRC-AC7 / TRC-AC10 / TRC-AC18): real api + ops log
 * channels writing real files under an `os.tmpdir()` directory the rig removes on `dispose()`, and a
 * reader for what they wrote. Not a test file (no `.test.`), so vitest does not collect it.
 *
 * The production store and the production log tree are never touched here: roots are explicit.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Redactor } from '@adhd/agent-plugin-tracing';

import { env } from '../config.js';
import { createLogChannels, type IAgentMcpChannels } from '../wire/channels.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSONL records are untyped by nature
export type Rec = Record<string, any> & { event: string };

export interface IOpsRig {
  channels: IAgentMcpChannels;
  roots: IAgentMcpChannels['roots'];
  /** Flushes and returns every ops record, in file order. */
  ops(): Promise<Rec[]>;
  /** Flushes and returns every api record, in file order. */
  api(): Promise<Rec[]>;
  /** Flushes and returns the raw text of every ops + api file. */
  text(): Promise<string>;
  dispose(): Promise<void>;
}

const readDir = (dir: string): string => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
  } catch {
    return '';
  }
};
const parse = (text: string): Rec[] =>
  text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Rec);

/**
 * Builds real channels over a fresh temp root.
 *
 * @param opts.knownSecrets credential VALUES the shared redactor must scrub
 * @param opts.redactor     override the redactor (`identityRedactor` is the negative control)
 */
export function makeOpsRig(opts: { knownSecrets?: string[]; redactor?: Redactor } = {}): IOpsRig {
  const root = mkdtempSync(join(tmpdir(), 'c536ce29-p2-'));
  const roots = { root, api: join(root, 'api'), ops: join(root, 'ops'), trace: join(root, 'trace'), temp: join(root, 'tmp') };
  const channels = createLogChannels({
    roots,
    logging: { ...env.config.logging, api: 'on' },
    knownSecrets: opts.knownSecrets ?? [],
    stderr: { write: () => undefined },
    ...(opts.redactor ? { redactor: opts.redactor } : {}),
  });
  const text = async (): Promise<string> => {
    await channels.flush();
    return readDir(roots.ops) + readDir(roots.api);
  };
  return {
    channels,
    roots,
    async ops() {
      await channels.flush();
      return parse(readDir(roots.ops));
    },
    async api() {
      await channels.flush();
      return parse(readDir(roots.api));
    },
    text,
    async dispose() {
      await channels.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
