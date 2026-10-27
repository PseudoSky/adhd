'use strict';
/**
 * release-waves.js — topological waves over the PENDING set only.
 *
 * Wave 0 holds pending projects with no pending runtime dependency; wave N holds projects whose pending
 * dependencies are all in earlier waves. A dependency that is NOT pending is ignored: it is already on the
 * registry at the version the dependent's range resolves to, so nothing has to be ordered against it.
 *
 * This replaces the ordering the removed `^version` / `^publish` closure edges gave for free, without pulling
 * unchanged dependencies into the task graph. A cycle among pending projects throws — never silently ordered.
 */

/**
 * @param {Array<{name:string, deps:Array<{depName:string}>}>} releaseSet discoverReleaseSet() output
 * @param {string[]} pendingNames npm package names that need release
 * @returns {string[][]} waves of npm package names, each sorted
 */
function computeWaves(releaseSet, pendingNames) {
  const pending = new Set(pendingNames);
  const need = new Map();
  for (const p of releaseSet) {
    if (!pending.has(p.name)) continue;
    need.set(p.name, new Set(p.deps.map((d) => d.depName).filter((n) => pending.has(n) && n !== p.name)));
  }
  for (const n of pending) if (!need.has(n)) throw new Error(`release-waves: pending project ${n} is not in the release set`);
  const waves = [];
  const done = new Set();
  while (done.size < need.size) {
    const wave = [...need].filter(([n, ds]) => !done.has(n) && [...ds].every((d) => done.has(d))).map(([n]) => n).sort();
    if (!wave.length) {
      const stuck = [...need.keys()].filter((n) => !done.has(n)).sort();
      throw new Error(`release-waves: dependency cycle among pending projects: ${stuck.join(', ')}`);
    }
    for (const n of wave) done.add(n);
    waves.push(wave);
  }
  return waves;
}

module.exports = { computeWaves };
