'use strict';
/**
 * release-plan.js — the release scope and its order, from `release:pending` alone (no nx graph, no
 * `nx show projects --affected`).
 *
 * Returns the pending projects as nx project names (what `--projects=` takes) grouped into topological waves over
 * the pending set. Also writes the release manifest the publish executor's backstop requires, so a publish
 * outside this scope still refuses. FAIL-LOUD like changed-set.js: no code path returns "everyone" as a fallback.
 */
const { discoverReleaseSet } = require('./range-resolvability');
const { computePending } = require('./release-pending');
const { computeWaves } = require('./release-waves');
const { readProjectName } = require('./changed-set');
const { writeReleaseManifest } = require('./release-manifest');
const { readState } = require('./published-state');

/**
 * @param {{ workspaceRoot: string, writeManifest?: boolean, releaseSet?: object[], state?: object,
 *           pending?: Array<{name:string}>, nameOf?: (root:string, projectRoot:string)=>string }} opts
 * @returns {{ projects: Array<{name:string, projectRoot:string, version:string, nxName:string, reasons:string[]}>,
 *             projectNames: string[], waves: string[][] }} waves are nx project names
 */
function planRelease(opts) {
  if (!opts || !opts.workspaceRoot) throw new Error('release-plan: planRelease requires { workspaceRoot }');
  const { workspaceRoot } = opts;
  const releaseSet = opts.releaseSet || discoverReleaseSet(workspaceRoot);
  const state = opts.state || readState(workspaceRoot);
  const pending = opts.pending || computePending({ workspaceRoot, releaseSet, state });
  const nameOf = opts.nameOf || readProjectName;
  const nxByNpm = new Map(releaseSet.map((p) => [p.name, nameOf(workspaceRoot, p.projectRoot)]));
  const projects = pending
    .map((p) => ({ ...p, nxName: nxByNpm.get(p.name) }))
    .sort((a, b) => a.nxName.localeCompare(b.nxName));
  const waves = computeWaves(releaseSet, pending.map((p) => p.name)).map((w) => w.map((n) => nxByNpm.get(n)));
  const projectNames = projects.map((p) => p.nxName);
  if (opts.writeManifest !== false) writeReleaseManifest(workspaceRoot, projectNames, { baseRef: 'published-state' });
  return { projects, projectNames, waves };
}

module.exports = { planRelease };
