import { tokenize } from '@adhd/apigen-core-client';
import type { Segment } from '@adhd/apigen-core-client';

/**
 * The basename of a command path without its final extension, using only string
 * operations (`node:path` is confined to `process.ts`). `'/usr/bin/touch'` -> `'touch'`,
 * `'server.js'` -> `'server'`.
 */
export function commandBaseName(command: string): string {
  const tail = command.split(/[\\/]/).filter(Boolean).pop() ?? command;
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? tail.slice(0, dot) : tail;
}

/** A casing-neutral apigen `Segment` for `raw` (same tokenisation the extractor uses). */
export function segmentOf(raw: string): Segment {
  const words = tokenize(raw);
  return { raw, words: words.length > 0 ? words : [raw.toLowerCase()] };
}
