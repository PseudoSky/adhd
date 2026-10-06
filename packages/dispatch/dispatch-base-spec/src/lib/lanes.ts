/**
 * lanes.ts — the lane / tool-grant contract (backlog 7ed25125, b5670d03).
 *
 * A milestone may declare the `lane` of work it performs and the `tool_grant`
 * its executing agent actually holds. A lane is satisfiable only if the grant
 * covers every one of the lane's requirement groups. `validateDagJson` refuses
 * a milestone whose grant cannot satisfy its lane, so a tool-starved agent is
 * stopped at validate time instead of fabricating results (the incident that
 * cost ~19M tokens and 22 invented item IDs).
 *
 * Each lane maps to a list of requirement groups; a group is satisfied when the
 * grant covers ANY alternative in it, and the lane is satisfied when EVERY group
 * is. A grant entry ending in `*` is a prefix wildcard (`mcp__backlog__*`).
 */

/** Tool requirement groups per built-in lane. Inner arrays are alternatives (any-of); outer is all-of. */
export const LANE_TOOL_REQUIREMENTS: Readonly<Record<string, readonly (readonly string[])[]>> = Object.freeze({
  'file-ops': [
    ['Read', 'ViewFile'],
    ['Write', 'WriteFile', 'Edit', 'EditFile'],
  ],
  research: [['WebSearch', 'FetchURL', 'WebFetch']],
  execution: [['Bash']],
  backlog: [['mcp__backlog__*']],
});

/** The built-in lane names. */
export const LANE_NAMES: readonly string[] = Object.freeze(Object.keys(LANE_TOOL_REQUIREMENTS));

/** True when `grant` covers `tool` (exact, or via a trailing-`*` prefix wildcard on either side). */
export function grantCovers(grant: readonly string[], tool: string): boolean {
  const toolPrefix = tool.endsWith('*') ? tool.slice(0, -1) : null;
  for (const g of grant) {
    if (g === tool) return true;
    if (g.endsWith('*') && tool.startsWith(g.slice(0, -1))) return true;
    if (toolPrefix !== null && g.startsWith(toolPrefix)) return true;
  }
  return false;
}

/**
 * The requirement groups a grant fails to satisfy for `lane`. Empty means the
 * grant satisfies the lane. Returns `null` for a lane that is not in the catalog.
 */
export function unsatisfiedLaneGroups(lane: string, grant: readonly string[]): string[][] | null {
  const groups = LANE_TOOL_REQUIREMENTS[lane];
  if (!groups) return null;
  return groups.filter((alts) => !alts.some((t) => grantCovers(grant, t))).map((alts) => [...alts]);
}
