/**
 * ci-env.ts — detects a CI run so a spec whose prerequisite (a built/installed
 * tree) is missing FAILS LOUDLY there instead of self-skipping (55ba4178,
 * B-AC11; AGENTS.md §7: a missing prerequisite must turn the suite red).
 *
 * This reads `CI` as PLATFORM DETECTION (every CI provider sets it), never as a
 * feature toggle: it changes whether a missing prerequisite is tolerated, not
 * what the code under test does.
 */
export function isCiRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['CI'];
  return v !== undefined && v !== '' && v.toLowerCase() !== 'false' && v !== '0';
}
