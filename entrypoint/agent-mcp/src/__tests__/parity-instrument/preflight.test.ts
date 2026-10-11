import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * Preflight verdict table (ported from the R2 cases; ticket 50e21ed9 AC2, 0ba70e47 AC1, 90758419 AC2; spec B2.AC9-AC11, AC17).
 * The SDK prober is injected, so nothing here launches a process or touches the network.
 */
const P = await loadParity('preflight.mjs');

const MARKER = P.DEFAULT_SPEC.marker as string;
const page = `${'<html><head>'}${MARKER}${'x'.repeat(400)}</head></html>`;
const out = (o: object) => ({ launched: true, listed: true, isError: false, wallMs: 400, text: page, ...o });

describe('parity preflight: classifyLeg verdict table', () => {
  const rows: Array<[string, object, string]> = [
    ['healthy fetch', out({}), 'GREEN'],
    ['stack failed to launch', { launched: false, text: 'spawn ENOENT', wallMs: 10 }, 'LAUNCH_FAIL'],
    ['fetch tool not listed', { launched: true, listed: false, wallMs: 10 }, 'LAUNCH_FAIL'],
    ['timed out', { timedOut: true, wallMs: 120000 }, 'TIMEOUT'],
    ['the R4 signature: blank content, isError false', out({ text: '', wallMs: 15 }), 'EMPTY_FALSE_SUCCESS'],
    ['whitespace-only content', out({ text: '  \n\t ' }), 'EMPTY_FALSE_SUCCESS'],
    ['content present but returned in 20 ms (a real TLS fetch cannot)', out({ wallMs: 20 }), 'EMPTY_FALSE_SUCCESS'],
    ['tool error with ordinary text', out({ isError: true, text: 'boom' }), 'TOOL_ERROR'],
    ['curl name-resolution failure reported as error', out({ isError: true, text: 'curl: (6) Could not resolve host' }), 'EGRESS_DENIED'],
    ['blocked text with isError false and no marker', out({ text: `${'blocked by proxy '.repeat(20)}` }), 'EGRESS_DENIED'],
    ['too few bytes', out({ text: `${MARKER}` }), 'MARKER_MISSING'],
    ['enough bytes, marker absent', out({ text: 'y'.repeat(500) }), 'MARKER_MISSING'],
  ];

  it.each(rows)('B2.AC9-AC11: %s -> %s', (_name, outcome, code) => {
    expect(P.classifyLeg(outcome).code).toBe(code);
  });

  it('B2.AC11: every verdict code the classifier can produce is declared in CODES (and the spec set is covered)', () => {
    const produced = new Set(rows.map((r) => r[2]));
    for (const c of produced) expect(P.CODES).toContain(c);
    expect(P.CODES).toContain('NOT_PROBEABLE');
  });

  it('B2.AC9: a custom spec threshold applies (minWallMs lowered lets a 20 ms fetch pass)', () => {
    expect(P.classifyLeg(out({ wallMs: 20 }), { minWallMs: 5 }).code).toBe('GREEN');
  });
});

describe('parity preflight: legs, exit code, run', () => {
  const surface = {
    C: { tools: ['web_fetch'], why: 'server-side tool' },
    A: { tools: ['WebFetch'] },
    B: { tools: ['fetch'], probe: { launch: { command: 'x', args: [], env: {} }, tool: 'fetch', args: (u: string) => ({ url: u }) } },
  };

  it('R3: legs are derived from the declared surface, sorted by arm; a surface without a probe is NOT_PROBEABLE', () => {
    const legs = P.deriveLegs(surface);
    expect(legs.map((l: { arm: string }) => l.arm)).toEqual(['A', 'B', 'C']);
    expect(legs.map((l: { probeable: boolean }) => l.probeable)).toEqual([false, true, false]);
    expect(legs[2].why).toBe('server-side tool');
    expect(legs[0].why).toMatch(/no zero-model probe/);
  });

  it('B2.AC17: exit code is 0 only if every probeable leg is GREEN; NOT_PROBEABLE does not fail it', () => {
    expect(P.exitCodeFor([{ code: 'GREEN' }, { code: 'NOT_PROBEABLE' }])).toBe(0);
    expect(P.exitCodeFor([{ code: 'GREEN' }, { code: 'EMPTY_FALSE_SUCCESS' }])).toBe(3);
    expect(P.exitCodeFor([{ code: 'NOT_PROBEABLE' }])).toBe(0);
  });

  it('B2.AC17: runPreflight maps a GREEN prober to exit 0 and records NOT_PROBEABLE legs without calling the prober', async () => {
    const probed: string[] = [];
    const r = await P.runPreflight(surface, {}, async (leg: { arm: string }) => {
      probed.push(leg.arm);
      return out({});
    });
    expect(probed).toEqual(['B']);
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.legs.map((l: { code: string }) => l.code)).toEqual(['NOT_PROBEABLE', 'GREEN', 'NOT_PROBEABLE']);
  });

  it('B2.AC17: the R4 empty-false-success prober makes the run exit 3; a throwing prober becomes LAUNCH_FAIL, not a crash', async () => {
    const empty = await P.runPreflight(surface, {}, async () => out({ text: '', wallMs: 20 }));
    expect([empty.exitCode, empty.ok, empty.legs[1].code]).toEqual([3, false, 'EMPTY_FALSE_SUCCESS']);
    const thrown = await P.runPreflight(surface, {}, async () => {
      throw new Error('launch exploded');
    });
    expect(thrown.exitCode).toBe(3);
    expect(thrown.legs[1].code).toBe('LAUNCH_FAIL');
  });

  it('R2.AC6: the receipt records identity fields; an absent dist is null and the policy hash is a sha256', async () => {
    const r = P.buildReceipt({ spec: P.DEFAULT_SPEC, distEntry: '/nonexistent/dist/index.js', nativeToolingVersion: '1.2.3', srtVersion: '0.0.9', policyText: '{"a":1}', legs: [] });
    expect(r.agentMcpDistSha).toBeNull();
    expect(r.nativeToolingVersion).toBe('1.2.3');
    expect(r.policySha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.targetUrl).toBe(P.DEFAULT_SPEC.targetUrl);
    expect(P.buildReceipt({ spec: P.DEFAULT_SPEC, distEntry: '/x', legs: [] }).policySha).toBeNull();
  });
});
