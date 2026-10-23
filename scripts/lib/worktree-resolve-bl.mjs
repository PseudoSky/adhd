#!/usr/bin/env node
/** Prints `<name>\t<uid>\t<title>` for a backlog id (used by worktree-setup.sh --bl). */
import { resolveBacklog } from './worktree-lib.mjs';

try {
  const r = resolveBacklog(process.argv[2] ?? '');
  console.log([r.name, r.uid, r.title.replace(/[\t\r\n]+/g, ' ')].join('\t'));
} catch (e) {
  console.error(`worktree-resolve-bl: ${e.message}`);
  process.exit(1);
}
