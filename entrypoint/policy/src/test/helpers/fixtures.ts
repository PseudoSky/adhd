import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** B2.0: the workspace policy the S2 and S6 scenarios gate on. */
export const WORKSPACE_YAML = `version: 1
attributes:
  role: name
  read_roots: paths
  write_roots: paths
  customers: names
  max_refund: number
defaults:
  - set: { role: guest, read_roots: [], write_roots: [], customers: [], max_refund: 0 }
permissions:
  - tool: files/read
    args: { path: { _within: $attributes.read_roots } }
  - tool: files/write
    context: { role: { _eq: dev } }
    args: { path: { _within: $attributes.write_roots } }
    set: { overwrite: false }
  - tool: files/*
    effect: deny
    args: { path: { _regex: '(^|/)\\.env$|(^|/)\\.ssh/' } }
  - tool: billing/refund
    effect: ask
    context: { role: { _eq: support } }
    args:
      _and:
        - { customer: { _in: $attributes.customers } }
        - { amount: { _lte: $attributes.max_refund } }
  - tool: billing/*
    effect: deny
    context: { role: { _eq: guest } }
`;

/** B5.0: the narrow policy; `agent/spawn` is child-creating because a permission reads `child.*`. */
export const NARROW_YAML = `version: 1
attributes:
  role: name
  read_roots: paths
  write_roots: paths
  repos: names
  max_refund: number
defaults:
  - where: { role: { _eq: reviewer } }
    set: { write_roots: [], repos: [acme/shop] }
permissions:
  - tool: agent/spawn
    effect: deny
    args:
      _not:
        _and:
          - { 'child.read_roots':  { _within: $attributes.read_roots } }
          - { 'child.write_roots': { _within: $attributes.write_roots } }
          - { 'child.repos':       { _contained_in: $attributes.repos } }
          - { 'child.max_refund':  { _lte: $attributes.max_refund } }
  - tool: agent/spawn
    context: { role: { _eq: orchestrator } }
    args: { agent_name: { _in: [reviewer] } }
`;

/** B6.2: a mistyped operator, an undeclared attribute, an absolute path in a project layer and a runtime read with no provider. */
export const BROKEN_YAML = `version: 1
attributes:
  role: name
  docs: paths
runtime:
  calls: number
defaults:
  - set: { docs: ["/opt/docs"] }
permissions:
  - tool: files/read
    args: { path: { _wthin: $attributes.docs } }
  - tool: files/write
    args: { team: { _eq: $attributes.team } }
  - tool: slack/post
    context: { 'runtime.calls': { _lt: 3 } }
`;

/** Writes `workspace-policy.yaml` (the project layer file discovery looks for) into `dir`. */
export async function writePolicy(dir: string, yaml: string): Promise<string> {
  const file = join(dir, 'workspace-policy.yaml');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, yaml);
  return file;
}

/** The B2.0 `dev` caller for a demo root: reads under work/, writes under work/out. */
export function devAttributes(demo: string): Record<string, unknown> {
  return { role: 'dev', read_roots: [`${demo}/work`], write_roots: [`${demo}/work/out`] };
}

/** The B2.0 `support` caller: may refund cust_1 up to 50. */
export const SUPPORT_ATTRIBUTES = { role: 'support', customers: ['cust_1'], max_refund: 50 } as const;

/** The CLI `--input` argument for a call. */
export function callInput(call: { tool?: string; args?: unknown; attributes?: unknown }): string {
  return JSON.stringify(call);
}
