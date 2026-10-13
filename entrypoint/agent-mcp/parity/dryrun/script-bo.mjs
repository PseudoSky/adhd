// PARITY-INSTRUMENT-ONLY
// Dry-run only: the scripted "model" of the R11 backlog-operator design. Straight-line async code over the same `io` adapter script.mjs uses, driving BOTH fakes (the fake claude for
// arm B, the fake Anthropic server for arm C). The role is chosen from the TOOLS the conversation was offered, which is what the real agents differ in (the backlog-operator is the only
// definition with the backlog MCP server; `performance` is the one with the agent-mcp dispatch tools; `review` has neither). The performance prompt (the full-flow TASK_PROMPT) is never parsed.
//   bo-performance: the owner's flow, in order: dispatch backlog-operator (select + implement + commit) -> dispatch review on the committed file -> revise the file and commit -> dispatch the
//                   SAME backlog-operator session to transition the item -> report. Each step reads the previous step's report; a failed step ends the run with an ESCALATE text.
//   bo-operator:    phase 1 (its prompt does not start with "Transition"): backlog_query (view ready) -> pick the first unblocked item -> backlog_claim -> write a file in the worktree and make a REAL
//                   `git commit` through the sandboxed shell tool -> reply. Phase 2 ("Transition <uid> ..."): backlog_transition -> reply.
//   bo-review:      read-only: reads the file named in its prompt and replies with a finding.
// io additionally offers `tool(re, input)`: call the tool whose name matches `re` (server-qualified spellings differ per arm) and return its text; `sessions[name]`: the session last used for an agent.
const envelope = (input) => ({ data: { input } });
const parse = (t) => { try { return JSON.parse(t); } catch { return {}; } };
const FAILED = /fatal:|exit status: [1-9]|Operation not permitted/;
const oneLine = (t, n = 300) => String(t).replace(/\s+/g, ' ').slice(0, n);

export async function runBoRole({ role, io }) {
  if (role === 'bo-performance') {
    const cwd = await io.cwd();
    const [impl] = await io.dispatchMany([{ name: 'backlog-operator', role: 'bo-operator', prompt: 'Select one random unblocked item from the backlog, implement it in the current working directory, and commit your work. Do not transition the item yet; report the item uid, the file you created and the commit sha.' }]);
    const m = /Implemented (\S+) in (\S+); commit ([0-9a-f]{7,40})/.exec(impl);
    if (!m) return `ESCALATE: the backlog operator did not report an implementation: ${oneLine(impl)}`;
    const [, uid, file, sha] = m;
    const [findings] = await io.dispatchMany([{ name: 'review', role: 'bo-review', prompt: `Review the committed change ${sha} (file ${file}) in the working directory. Report findings by severity with file:line evidence.` }]);
    await io.call('write', { path: `${cwd}/${file}`, content: `${uid}: revised after review (${oneLine(findings, 80)})\n` });
    const added = String(await io.call('shell', { argv: ['git', 'add', file], line: `git add ${file}`, directory: cwd }));
    const msg = `r11 dry run: revise ${uid} after review`;
    const committed = String(await io.call('shell', { argv: ['git', 'commit', '-m', msg], line: `git commit -m "${msg}"`, directory: cwd }));
    if (FAILED.test(`${added}\n${committed}`)) return `ESCALATE: git commit of the revision failed in ${cwd}: ${oneLine(`${added} ${committed}`)}`;
    const sha2 = String(await io.call('shell', { argv: ['git', 'rev-parse', 'HEAD'], line: 'git rev-parse HEAD', directory: cwd })).trim().split('\n').pop();
    const [done] = await io.dispatchMany([{ name: 'backlog-operator', role: 'bo-operator', session: io.sessions?.['backlog-operator'], prompt: `Transition ${uid} to done now that the revision is committed (${sha2}).` }]);
    return `Flow complete for ${uid}: implemented in ${sha}, reviewed, revised in ${sha2}. Backlog operator: ${done}`;
  }
  if (role === 'bo-review') {
    const cwd = await io.cwd();
    const file = /file (\S+)\)/.exec(io.prompt ?? '')?.[1] ?? 'README.md';
    const text = String(await io.call('read', { path: `${cwd}/${file}` }));
    return `mode: static\nmedium ${file}:1 the change is a stub copy of the README; replace it with the actual implementation (read ${text.length} bytes).`;
  }
  // bo-operator
  const transition = /^\s*Transition (\S+) to (\S+)/.exec(io.prompt ?? '');
  if (transition) {
    const tr = parse(await io.tool(/(^|__)backlog_transition$/, envelope({ uid: transition[1], by: 'backlog-operator:1', toStatus: transition[2], note: oneLine(io.prompt, 160) })));
    return tr?.ok === false ? `ESCALATE: transition failed: ${oneLine(JSON.stringify(tr))}` : `Transitioned ${transition[1]}: ${tr?.data?.from ?? '?'} -> ${tr?.data?.to ?? '?'}.`;
  }
  const cwd = await io.cwd();
  const q = parse(await io.tool(/(^|__)backlog_query$/, envelope({ view: 'ready', limit: 50 })));
  const items = q?.data?.items ?? [];
  if (!items.length) return 'ESCALATE: no unblocked item in the backlog';
  const pick = items[0];
  await io.tool(/(^|__)backlog_claim$/, envelope({ uid: pick.uid, by: 'backlog-operator:1', action: 'claim' }));
  const file = `r11-${pick.uid}.txt`;
  const copied = String(await io.call('shell', { argv: ['cp', 'README.md', file], line: `cp README.md ${file}`, directory: cwd }));
  const added = String(await io.call('shell', { argv: ['git', 'add', file], line: `git add ${file}`, directory: cwd }));
  const msg = `r11 dry run: execute ${pick.uid}`;
  const committed = String(await io.call('shell', { argv: ['git', 'commit', '-m', msg], line: `git commit -m "${msg}"`, directory: cwd }));
  if (FAILED.test(`${copied}\n${added}\n${committed}`)) return `ESCALATE: git commit failed in ${cwd}: ${oneLine(`${copied} ${added} ${committed}`)}`;   // the fake operator reports a failed commit instead of pressing on (a real model would see the same text)
  const sha = String(await io.call('shell', { argv: ['git', 'rev-parse', 'HEAD'], line: 'git rev-parse HEAD', directory: cwd })).trim().split('\n').pop();
  return `Implemented ${pick.uid} in ${file}; commit ${sha}. (${pick.title})`;
}
