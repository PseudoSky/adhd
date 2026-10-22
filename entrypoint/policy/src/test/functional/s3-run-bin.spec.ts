/**
 * guards: `adhd-policy run` launches a tool the policy refuses or asks about, lets a denied cwd through, forwards --adhd-* flags to the child, or loses the child's exit code.
 * tier: S
 * cites: docs/plan/policy-core/tickets/T13.md (@S3.1, @S3.2, @S3.3, @S3.6; B3.1)
 * item: qa-variance (docs/discovery/qa-test-variance-tail-policy.md)
 * red: pending (tests not run per user); assertions are unchanged, only where the fixture directory comes from moved.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runVerb } from '../../wrapper/verbs/run';
import { createFakeLauncher } from '../helpers/fake-launcher';
import { capturedDeps } from '../helpers/run-deps';
import { useScratchDirs } from '../helpers/tmp';

/** B3.0: dev may run "touch" with the cwd inside write_roots; interns "ask"; any cwd under ".ssh" is denied. */
const GATE_YAML = `version: 1
attributes:
  role: name
  write_roots: paths
defaults:
  - set: { role: guest, write_roots: [] }
permissions:
  - tool: bin/touch
    context: { role: { _eq: dev } }
    args: { cwd: { _within: $attributes.write_roots } }
  - tool: bin/touch
    effect: ask
    context: { role: { _eq: intern } }
  - tool: bin/touch
    effect: deny
    args: { cwd: { _regex: '(^|/)\\.ssh(/|$)' } }
`;

interface IDemo {
  readonly demo: string;
  readonly out: string;
  readonly work: string;
  readonly ssh: string;
  readonly gate: string;
}

const scratch = useScratchDirs('s3-run');
let shared: IDemo;

/**
 * One demo tree for the whole file, built once. Every case only reads it (the
 * gate, the work/out/ssh directories) and writes its own uniquely named
 * attributes file, so no case can see another's state; the one case that needs
 * a different gate writes its own gate file instead of rewriting this one.
 */
beforeAll(async () => {
  const dir = await scratch.fresh('demo');
  shared = {
    demo: dir,
    out: join(dir, 'work', 'out'),
    work: join(dir, 'work'),
    ssh: join(dir, 'home', '.ssh'),
    gate: join(dir, 'gate.yaml'),
  };
  await mkdir(shared.out, { recursive: true });
  await mkdir(shared.ssh, { recursive: true });
  await writeFile(shared.gate, GATE_YAML);
});

async function withDemo(fn: (demo: IDemo) => Promise<void>): Promise<void> {
  await fn(shared);
}

let attrsCounter = 0;

/** Writes `value` to a file no other case uses and returns the `@file` flag value. */
async function attrsFile(dir: string, name: string, value: unknown): Promise<string> {
  attrsCounter += 1;
  const file = join(dir, `${attrsCounter}-${name}`);
  await writeFile(file, JSON.stringify(value));
  return `@${file}`;
}

describe('Put a policy in front of any command - run bin:', () => {
  it('@S3.1 a developer in the write root runs the command unchanged: one start, argv and cwd as given, no --adhd-* flag, the child exit code', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher(() => ({ exit: 0, stdout: 'child-out\n', stderr: 'child-err\n' }));
      const captured = capturedDeps({ cwd: d.out, launcher });
      const attrs = await attrsFile(d.demo, 'attrs.json', { role: 'dev', write_roots: [d.out] });
      const code = await runVerb(['bin:touch', '--spec', d.gate, '--adhd-attributes', attrs, '--', 'made-by-dev.txt'], captured.deps);
      expect(code).toBe(0);
      expect(launcher.started).toHaveLength(1);
      expect(launcher.started[0]).toMatchObject({ command: 'touch', args: ['made-by-dev.txt'], cwd: d.out });
      expect(JSON.stringify(launcher.started)).not.toContain('--adhd');
      expect(JSON.stringify(launcher.started)).not.toContain('--spec');
      expect(captured.stdout.join('')).toBe('child-out\n');
      expect(captured.stderr.join('')).toContain('child-err');
    });
  });

  it('@S3.1 the exit code is the child\'s own, not a constant', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher(() => ({ exit: 7 }));
      const captured = capturedDeps({ cwd: d.out, launcher });
      const attrs = await attrsFile(d.demo, 'attrs.json', { role: 'dev', write_roots: [d.out] });
      expect(await runVerb(['bin:touch', '--spec', d.gate, '--adhd-attributes', attrs, '--', 'x'], captured.deps)).toBe(7);
      expect(launcher.started).toHaveLength(1);
    });
  });

  const refused: Array<{ name: string; attributes: (d: IDemo) => unknown | undefined; cwd: (d: IDemo) => string; reason: RegExp }> = [
    { name: 'dev with write_roots outside the cwd', attributes: (d) => ({ role: 'dev', write_roots: [d.out] }), cwd: (d) => d.work, reason: /no permission allows bin\/touch/ },
    { name: 'dev whose write root contains a .ssh cwd (deny wins)', attributes: (d) => ({ role: 'dev', write_roots: [join(d.demo, 'home')] }), cwd: (d) => d.ssh, reason: /denied by permission global:2/ },
    { name: 'no attributes at all (guest)', attributes: () => undefined, cwd: (d) => d.out, reason: /no permission allows bin\/touch/ },
    { name: 'intern (ask with nobody to answer)', attributes: (d) => ({ role: 'intern', write_roots: [d.out] }), cwd: (d) => d.out, reason: /requires approval/ },
  ];
  for (const row of refused) {
    it(`@S3.2 a refused call never starts the command: ${row.name}`, async () => {
      await withDemo(async (d) => {
        const launcher = createFakeLauncher();
        const captured = capturedDeps({ cwd: row.cwd(d), launcher });
        const value = row.attributes(d);
        const flags = value === undefined ? [] : ['--adhd-attributes', await attrsFile(d.demo, 'attrs.json', value)];
        const code = await runVerb(['bin:touch', '--spec', d.gate, ...flags, '--', 'never.txt'], captured.deps);
        expect(code).toBe(3);
        expect(launcher.started).toHaveLength(0);
        expect(captured.stderr.join('')).toMatch(row.reason);
        expect(captured.stdout.join('')).toBe('');
      });
    });
  }

  it('@S3.3 ask with nobody to answer is a refusal, and the attributes file is re-read on every invocation', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher();
      const who = join(d.demo, 's3-who.json');
      const argv = ['bin:touch', '--spec', d.gate, '--adhd-attributes', `@${who}`, '--', 'again.txt'];
      await writeFile(who, JSON.stringify({ role: 'dev', write_roots: [d.out] }));
      const first = capturedDeps({ cwd: d.out, launcher });
      expect(await runVerb(argv, first.deps)).toBe(0);
      expect(launcher.started).toHaveLength(1);
      await writeFile(who, JSON.stringify({ role: 'intern', write_roots: [d.out] }));
      const second = capturedDeps({ cwd: d.out, launcher });
      expect(await runVerb(argv, second.deps)).toBe(3);
      expect(launcher.started).toHaveLength(1);
      expect(second.stderr.join('')).toMatch(/requires approval/);
    });
  });

  it('@S3.6 attributes that are not a JSON object refuse to start (exit 2, D-06)', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher();
      for (const bad of ['"not-an-object"', '[1]', '42', 'null']) {
        const badFile = join(d.demo, 's3-bad-attrs.json');
        await writeFile(badFile, bad);
        const captured = capturedDeps({ cwd: d.out, launcher });
        const code = await runVerb(['bin:touch', '--spec', d.gate, '--adhd-attributes', `@${badFile}`, '--', 'never.txt'], captured.deps);
        expect(code, bad).toBe(2);
        expect(captured.stderr.join('')).toMatch(/must be a JSON object/);
      }
      expect(launcher.started).toHaveLength(0);
    });
  });

  it('@S3.1 a forced policy set reaches the child: cwd and the whole argv are replaced before the launcher starts it (D-07)', async () => {
    await withDemo(async (d) => {
      const forcedCwd = join(d.out, 'sub');
      await mkdir(forcedCwd, { recursive: true });
      const gate = GATE_YAML.replace(
        'args: { cwd: { _within: $attributes.write_roots } }',
        `args: { cwd: { _within: $attributes.write_roots } }\n    set: { argv: [forced.txt], cwd: '${forcedCwd}' }`
      );
      const forcedGate = join(d.demo, 'gate-forced.yaml');
      await writeFile(forcedGate, gate);
      const launcher = createFakeLauncher();
      const captured = capturedDeps({ cwd: d.out, launcher });
      const attrs = await attrsFile(d.demo, 'attrs.json', { role: 'dev', write_roots: [d.out] });
      expect(await runVerb(['bin:touch', '--spec', forcedGate, '--adhd-attributes', attrs, '--', 'asked.txt', 'extra'], captured.deps)).toBe(0);
      expect(launcher.started).toHaveLength(1);
      expect(launcher.started[0]).toMatchObject({ command: 'touch', args: ['forced.txt'], cwd: forcedCwd });
    });
  });

  it('@S3.2 run --name is refused with exit 2 and starts nothing (--name applies to serve only)', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher();
      const captured = capturedDeps({ cwd: d.out, launcher });
      const code = await runVerb(['bin:touch', '--name', 'alias', '--spec', d.gate, '--', 'x'], captured.deps);
      expect(code).toBe(2);
      expect(captured.stderr.join('')).toContain('--name applies to serve only');
      expect(launcher.started).toHaveLength(0);
    });
  });

  it('@S3.2 run needs exactly one bin: source; anything else is exit 2 and starts nothing', async () => {
    await withDemo(async (d) => {
      const launcher = createFakeLauncher();
      for (const argv of [[], ['bin:touch', 'bin:echo'], ['file:./x.ts'], ['remote:http://x']]) {
        const captured = capturedDeps({ cwd: d.out, launcher });
        expect(await runVerb([...argv, '--spec', d.gate], captured.deps), argv.join(' ')).toBe(2);
      }
      expect(launcher.started).toHaveLength(0);
    });
  });
});
