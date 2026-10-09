/**
 * skill-quick-reference.spec.ts — backlog 4d24f105 (BK10), plan
 * 9ed453c1-b113-473d-8c35-fc6dc2541306.
 *
 * The 86 KB `skill/SKILL.md` was `cat`-ed whole by every agent and re-sent every
 * turn, and `adhd-backlog get <uid>` died with a remedy-free
 * `Unexpected positional argument`. The skill is now a one-screen quick
 * reference (`SKILL.md`) plus a long-form `REFERENCE.md`, and `get <uid>` works.
 *
 *  - AC10.1  quick reference size budget + 40-line cap + pointer to REFERENCE.md,
 *            and EVERY command line documented there is executed against the
 *            real built CLI on a scratch store (a doc line that fails fails here).
 *  - AC10.2  `get <uid>` sugar; every other positional error prints the exact
 *            working `--input` invocation, and that invocation actually runs.
 *
 * Every CLI assertion spawns the REAL BUILT `dist/index.js` against a
 * throwaway `ADHD_BACKLOG_DATABASE_PATH` — never the production backlog.
 * Teeth: reverting `translateGetPositional`/`detectCliPositionalViolation`
 * wiring in cli.ts turns the AC10.2 block red; bloating SKILL.md past the
 * budget or dropping the REFERENCE.md pointer turns the AC10.1 block red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';
import { translateGetPositional } from './cli-input-envelope.js';
import { installSkill } from './install-skill.js';
import { BACKLOG_VERBS } from './vocabulary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const SKILL_DIR = join(HERE, '..', 'skill');
const SKILL = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const REFERENCE = readFileSync(join(SKILL_DIR, 'REFERENCE.md'), 'utf8');

/** Size budget for the quick reference: it is read in full by every agent, every session. */
const SKILL_BUDGET_BYTES = 6 * 1024;
/** AC10.1: the quick reference proper (heading through the pointer) is at most this many lines. */
const QUICK_REF_MAX_LINES = 40;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let tmpRoot: string;
let dbPath: string;
let uid: string;
let uid2: string;

function runBin(args: string[]): Run {
  return runIsolatedBin(DIST_INDEX, args, tmpRoot, {
    extraEnv: { ADHD_BACKLOG_DATABASE_PATH: dbPath },
  });
}

/** Minimal shell-word splitter: single quotes, double quotes, bare words. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function lastJson(stream: string): Record<string, unknown> | undefined {
  const lines = stream.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse((lines[i] ?? '').trim()) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v))
        return v as Record<string, unknown>;
    } catch {
      /* log line */
    }
  }
  return undefined;
}

const envelopeOf = (r: Run) => lastJson(r.stdout) ?? lastJson(r.stderr);

function messageOf(r: Run): string {
  const e = envelopeOf(r);
  const err = e?.['error'] as { message?: string } | undefined;
  return err?.message ?? (e?.['message'] as string | undefined) ?? `${r.stdout}\n${r.stderr}`;
}

function createItem(title: string): string {
  const r = runBin([
    'create',
    '--input',
    JSON.stringify({ title, body: 'b', project: 'demo', by: 'bk10-spec' }),
  ]);
  const data = envelopeOf(r)?.['data'] as { uid?: string } | undefined;
  if (!data?.uid) throw new Error(`seed create failed: ${r.stdout}${r.stderr}`);
  return data.uid;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-skill-qr-'));
  dbPath = join(tmpRoot, 'qr.db');
  const p = runBin(['upsert-project', '--input', JSON.stringify({ name: 'demo', by: 'bk10-spec' })]);
  if (p.status !== 0) throw new Error(`seed project failed: ${p.stdout}${p.stderr}`);
  uid = createItem('quick reference subject');
  uid2 = createItem('quick reference blocker target');
}, 120_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('4d24f105 AC10.1 — SKILL.md is a short quick reference; the long tail lives in REFERENCE.md', () => {
  it(`4d24f105 AC10.1 SKILL.md stays under the ${SKILL_BUDGET_BYTES}-byte budget`, () => {
    expect(Buffer.byteLength(SKILL, 'utf8')).toBeLessThanOrEqual(SKILL_BUDGET_BYTES);
  });

  it(`4d24f105 AC10.1 the quick reference (heading to the REFERENCE pointer) is at most ${QUICK_REF_MAX_LINES} lines`, () => {
    const lines = SKILL.split('\n');
    const start = lines.findIndex((l) => l.startsWith('# '));
    const end = lines.findIndex((l) => l.startsWith('## Long reference'));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThanOrEqual(QUICK_REF_MAX_LINES);
  });

  it('4d24f105 AC10.1 keeps the skill frontmatter (name + description) so skill loaders still find it', () => {
    expect(SKILL.startsWith('---\nname: backlog-usage\ndescription: ')).toBe(true);
  });

  it('4d24f105 AC10.1 points at REFERENCE.md, which exists, is the split (not a deletion) and still documents every verb', () => {
    expect(SKILL).toContain('REFERENCE.md');
    expect(existsSync(join(SKILL_DIR, 'REFERENCE.md'))).toBe(true);
    expect(REFERENCE.length).toBeGreaterThan(50_000);
    for (const verb of BACKLOG_VERBS) expect(`${SKILL}\n${REFERENCE}`, verb).toContain(verb);
  });

  it('4d24f105 AC10.1 names get/query/create/claim/transition with the exact --input form', () => {
    for (const verb of ['get', 'query', 'create', 'claim', 'transition']) {
      expect(SKILL, verb).toMatch(new RegExp(`adhd-backlog ${verb} (<uid>|--input '\\{)`));
    }
  });

  it('4d24f105 AC10.1 install-skill ships REFERENCE.md next to SKILL.md so the link resolves in the host', () => {
    const home = mkdtempSync(join(tmpdir(), 'backlog-skill-qr-home-'));
    try {
      const results = installSkill(['--host', 'claude'], home, home);
      const installed = join(dirname(results[0]!.path), 'REFERENCE.md');
      expect(readFileSync(installed, 'utf8')).toBe(REFERENCE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('4d24f105 AC10.1 EVERY documented command line runs and succeeds against the real built CLI', () => {
    const block = /```\n([\s\S]*?)\n```/.exec(SKILL)?.[1] ?? '';
    const commands = block.split('\n').filter((l) => l.startsWith('adhd-backlog '));
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const cmd of commands) {
      const argv = tokenize(
        cmd.replace(/^adhd-backlog /, '').replace(/<uid2>/g, uid2).replace(/<uid>/g, uid)
      );
      const r = runBin(argv);
      const env = envelopeOf(r);
      expect(r.status, `${cmd}\n${r.stdout}${r.stderr}`).toBe(0);
      expect(env?.['ok'], cmd).toBe(true);
    }
  }, 180_000);
});

describe('4d24f105 AC10.2 — positional get works; other positionals print the working invocation', () => {
  it('4d24f105 AC10.2 translateGetPositional rewrites `get <uid>` and leaves every other shape alone', () => {
    expect(translateGetPositional(['get', 'abc12345'])).toEqual({
      kind: 'argv',
      argv: ['get', '--input', '{"uid":"abc12345"}'],
    });
    expect(translateGetPositional(['get', '--input', '{}'])).toEqual({ kind: 'passthrough' });
    expect(translateGetPositional(['get', '--help'])).toEqual({ kind: 'passthrough' });
    expect(translateGetPositional(['get'])).toEqual({ kind: 'passthrough' });
    expect(translateGetPositional(['query', 'x'])).toEqual({ kind: 'passthrough' });
    expect(translateGetPositional(['get', 'a', 'b']).kind).toBe('error');
  });

  it('4d24f105 AC10.2 `get <full uid>` and `get <8-char prefix>` return the same item as the --input form', () => {
    const viaInput = envelopeOf(runBin(['get', '--input', JSON.stringify({ uid })]));
    const viaPositional = runBin(['get', uid]);
    const viaPrefix = runBin(['get', uid.slice(0, 8)]);
    expect(viaPositional.status).toBe(0);
    expect(viaPrefix.status).toBe(0);
    expect(envelopeOf(viaPositional)).toEqual(viaInput);
    expect(envelopeOf(viaPrefix)).toEqual(viaInput);
    expect((envelopeOf(viaPositional)?.['data'] as { uid: string }).uid).toBe(uid);
  });

  it('4d24f105 AC10.2 `get <unknown uid>` keeps the verb\'s own not-found failure (non-zero), not a usage error', () => {
    const r = runBin(['get', 'deadbeef']);
    expect(r.status).not.toBe(0);
    expect(messageOf(r)).not.toContain('Unexpected positional');
  });

  it('4d24f105 AC10.2 `get <uid> <extra>` exits 2 and prints the working get invocation', () => {
    const r = runBin(['get', uid, 'extra']);
    expect(r.status).toBe(2);
    const msg = messageOf(r);
    expect(msg).toContain('Unexpected positional argument: "extra"');
    expect(msg).toContain(`adhd-backlog get --input '{"uid":"<uid>"}'`);
  });

  it('4d24f105 AC10.2 a positional on any other verb is rejected with that verb\'s exact working --input form, and that form runs', () => {
    const fresh = createItem('positional remedy subject');
    const r = runBin(['claim', fresh]);
    expect(r.status).toBe(2);
    const msg = messageOf(r);
    expect(msg).toContain(`Unexpected positional argument: "${fresh}"`);
    const m = /Run: adhd-backlog (.+)$/.exec(msg);
    expect(m, msg).not.toBeNull();
    // Run the printed invocation, filling the schema placeholders with real values.
    const printed = (m as RegExpExecArray)[1] as string;
    const argv = tokenize(printed);
    const input = JSON.parse(argv[argv.indexOf('--input') + 1] as string) as Record<string, unknown>;
    input['uid'] = fresh;
    input['by'] = 'bk10-spec:1';
    argv[argv.indexOf('--input') + 1] = JSON.stringify(input);
    const ran = runBin(argv);
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    expect(envelopeOf(ran)?.['ok']).toBe(true);
  });

  it('4d24f105 AC10.2 an unknown command and `--help` are not reclassified as positional errors', () => {
    const unknown = runBin(['no-such-verb', 'x']);
    expect(messageOf(unknown)).not.toContain('takes its params as JSON');
    const help = runBin(['claim', '--help']);
    expect(help.status).toBe(0);
  });
});
