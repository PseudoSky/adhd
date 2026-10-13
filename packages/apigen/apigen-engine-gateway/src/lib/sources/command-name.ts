import { tokenize } from '@adhd/apigen-core-client';
import type { Segment } from '@adhd/apigen-core-client';

/** Executable extensions stripped from a command basename; any other suffix is part of the name. */
const EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|js|mjs|cjs|py)$/i;

/**
 * The basename of a command path without a known executable extension, using only
 * string operations. `'/usr/bin/touch'` -> `'touch'`, `'server.js'` -> `'server'`;
 * versioned names are kept whole (`'python3.11'` stays `'python3.11'`).
 */
export function commandBaseName(command: string): string {
  const tail = command.split(/[\\/]/).filter(Boolean).pop() ?? command;
  const stripped = tail.replace(EXECUTABLE_EXTENSION, '');
  return stripped.length > 0 ? stripped : tail;
}

/**
 * The operation-id prefix for a source: the user-chosen `alias` when given, else the
 * command basename, lowercased to `[a-z0-9_-]` (anything else becomes `-`), never empty.
 * Never derived from anything the upstream says about itself.
 */
export function sourceNameOf(command: string, alias?: string): string {
  const clean = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean(alias ?? '') || clean(commandBaseName(command)) || 'server';
}

/** A casing-neutral apigen `Segment` for `raw` (same tokenisation the extractor uses). */
export function segmentOf(raw: string): Segment {
  const words = tokenize(raw);
  return { raw, words: words.length > 0 ? words : [raw.toLowerCase()] };
}
