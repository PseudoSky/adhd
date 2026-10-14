/**
 * `extractHtml` cost and behaviour (backlog cbad68d4). Every title carries `cbad68d4 AC<n>`, the ids stored on the item:
 *
 *   AC1  extractHtml / metaContent cost is linear: a deterministic work bound (characters the scanners advanced over,
 *        counted via the optional `stats` argument - never wall-clock) on 1 MB adversarial inputs
 *   AC2  ordinary-page output is unchanged (checked against the previous regex implementation, kept below as the oracle)
 *   AC3  negative control: with the memo disabled (the rescan-per-opener defect the old lazy regexes had) the bound
 *        tests go red. The dispatch harness runs that mutant against this file.
 *
 * The oracle (`legacyExtractHtml`) is the implementation this change replaced, verbatim. It is only ever run on
 * small inputs (it is quadratic by construction).
 *
 * guards: extractHtml or metaContent regress to quadratic work on a 1 MB adversarial page (unterminated openers, nesting, repeated meta tags), or ordinary-page output differs from the previous regex implementation.
 * tier: S
 * cites: cbad68d4 AC1, AC2, AC3.
 */
import { describe, expect, it } from 'vitest';

import { WEB_FETCH_MAX_BYTES, extractHtml, type IExtractStats } from '../tools/web-fetch.js';

// ---- oracle: the pre-change implementation -------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function legacyDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function legacyMeta(html: string, name: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const n = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (n?.toLowerCase() !== name) continue;
    const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (c !== undefined) return legacyDecode(c).trim();
  }
  return undefined;
}
function legacyExtractHtml(html: string): { title: string; meta: Array<[string, string]>; text: string } {
  const title = legacyDecode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const meta: Array<[string, string]> = [];
  for (const name of ['viewport', 'description']) {
    const v = legacyMeta(html, name);
    if (v) meta.push([`meta-${name}`, v]);
  }
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|pre|blockquote)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = legacyDecode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n')
    .trim();
  return { title, meta, text };
}

// ---- fixtures ------------------------------------------------------------------------------------------------
const FIXTURES: Record<string, string> = {
  'example.com': '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Example Domain</title><style>body{x:y}</style></head><body><h1>Example Domain</h1><p>This domain is for use in &amp; examples.</p></body></html>',
  'existing script/comment test': '<title> A &amp; B </title><script>evil()</script><!-- c --><p>one</p><p>two &#65;</p>',
  'fixture page (bridge e2e)': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture Title R6B</title></head><body><h1>Fixture Heading</h1><p>Body text from the local fixture.</p></body></html>',
  'article with nested blocks': '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><META NAME="Description" CONTENT="A &quot;quoted&quot; description"><meta name="viewport" content=""><title>News &mdash; Today</title><script type="text/javascript">var a = "</p>"; if (a < 3 && b > 2) {}</script><style media="all">p > a { color: red }</style><noscript><img src="x.gif"></noscript></head><body><header><nav><ul><li><a href="/">Home</a></li><li><a href="/a">A</a></li></ul></nav></header><article><h2>Headline</h2><p>First <b>bold</b> and <i>italic</i> text.<br>Line two<br/>Line three</p><pre>  keep   spacing\n  here</pre><table><tr><td>c1</td><td>c2</td></tr></table><template><p>hidden</p></template><!-- a comment <p>inside</p> --><footer>&copy; 2026 &#x41;&#66; &nbsp;done</footer></article></body></html>',
  'uppercase tags': '<HTML><HEAD><TITLE>Up</TITLE><SCRIPT>x</SCRIPT ></HEAD><BODY><P>Hi</P ><DIV>there</DIV></BODY></HTML>',
  'header is not head': '<header>keep me</header><headline>and me</headline><p>x</p>',
  'unterminated script': '<p>before</p><script>var x = 1;<p>after</p>',
  'unterminated comment': '<p>a</p><!-- never closed <p>b</p>',
  'unterminated tag': '<p>a</p><b <i>x</i> and more text with no end',
  'unterminated title': '<title>never closed<p>body</p>',
  'unterminated meta': '<meta name="description" content="d"<p>body</p>',
  'unterminated script then complete style': '<script>a<style>b</style>c',
  'lt gt soup': 'a < b > c <> d <<>> e << f',
  'title in comment': '<!-- <title>Hidden</title> --><title>Real</title>',
  'duplicate meta, first without content': '<meta name="description"><meta name="description" content="second"><meta name="description" content="third">',
  'empty content wins': '<meta name="viewport" content=""><meta name="viewport" content="later">',
  'meta with angle bracket inside': '<meta name="description" <meta name="x" content="y">',
  'nested same-name blocks': '<script>a<script>b</script>c</script>d',
  'script-like names': '<script-x>q</script-x><scripts>r</scripts>t',
  'entities': '<p>&lt;tag&gt; &amp;amp; &#128512; &#x1F600; &unknown; &#0; &#99999999;</p>',
  'empty': '',
  'text only': 'just some text\n\n\nwith   blank lines',
};

describe('cbad68d4 AC2: ordinary-page extraction is unchanged', () => {
  it.each(Object.entries(FIXTURES))('cbad68d4 AC2: %s is identical to the previous implementation', (_name, html) => {
    expect(extractHtml(html)).toEqual(legacyExtractHtml(html));
  });

  it('cbad68d4 AC2: the headline outputs are the literal values the existing tests assert', () => {
    expect(extractHtml(FIXTURES['existing script/comment test']!)).toEqual({ title: 'A & B', meta: [], text: 'one\ntwo A' });
    expect(extractHtml(FIXTURES['example.com']!)).toEqual({
      title: 'Example Domain',
      meta: [['meta-viewport', 'width=device-width,initial-scale=1']],
      text: 'Example Domain\nThis domain is for use in & examples.',
    });
  });

  it('cbad68d4 AC2: 4000 deterministic random token soups (unterminated openers, nesting, case, stray brackets) match the oracle exactly', () => {
    const tokens = [
      '<script', '<script>', '</script>', '</SCRIPT >', '<style>', '</style>', '<noscript', '</noscript>', '<template>', '</template>',
      '<head>', '</head>', '<header>', '<title>', '</title>', '<title', '<!--', '-->', '<!-->', '<', '>', '<>', '<<', '>>', '<p>', '</p>',
      '<br>', '<br/>', '<div class="a">', '</div >', '<meta name="description" content="d">', '<meta name="viewport" content="v">',
      '<meta name="description">', '<meta', '<META NAME=\'viewport\' CONTENT=\'x\'>', 'text ', 'a&amp;b ', '&#65;', '\n', ' ', '"', "'", '=',
    ];
    let seed = 0x2f6e2b1;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 4000; i += 1) {
      const len = rnd(14);
      let html = '';
      for (let j = 0; j < len; j += 1) html += tokens[rnd(tokens.length)];
      expect(extractHtml(html), JSON.stringify(html)).toEqual(legacyExtractHtml(html));
    }
  });

  it('cbad68d4 AC2: the adversarial shapes themselves (at 2 KB, where the oracle is still cheap) produce identical output', () => {
    for (const [name, unit] of ADVERSARIAL) {
      const html = unit.repeat(Math.ceil(2048 / unit.length));
      expect(extractHtml(html), name).toEqual(legacyExtractHtml(html));
    }
  });
});

// ---- AC1: the work bound --------------------------------------------------------------------------------------
/** [name, repeated unit]: each shape makes the old lazy regexes rescan to end-of-input once per opener. */
const ADVERSARIAL: Array<[string, string]> = [
  ['<script ', '<script '],
  ['<<<<', '<<<<'],
  ['<!--', '<!--'],
  ['<meta ', '<meta '],
  ['<title ', '<title '],
  ['<style><script ', '<style><script '],
  ['<noscript <template <head ', '<noscript <template <head '],
  ['</p ', '</p '],
  ['<br ', '<br '],
  ['<a <a <a >', '<a '],
];

/** Generous constant: the scanners make ~6 forward passes over the input; the old behaviour is ~n/2 passes. */
const MAX_PASSES = 12;

function scan(html: string): number {
  const stats: IExtractStats = { scanned: 0 };
  extractHtml(html, stats);
  return stats.scanned;
}

describe('cbad68d4 AC1: extraction work is linear on 1 MB adversarial input', () => {
  it.each(ADVERSARIAL)('cbad68d4 AC1 / bc799330 AC4 (cross-reference to this item): %s repeated to 1 MB stays within the linear work bound', (_name, unit) => {
    const html = unit.repeat(Math.ceil(WEB_FETCH_MAX_BYTES / unit.length)).slice(0, WEB_FETCH_MAX_BYTES);
    expect(html.length).toBe(WEB_FETCH_MAX_BYTES);
    const scanned = scan(html);
    expect(scanned).toBeGreaterThanOrEqual(html.length); // the counter really counts: at least one full pass
    expect(scanned).toBeLessThanOrEqual(MAX_PASSES * html.length);
  });

  it('cbad68d4 AC1: the bound is a property of size, not of the shape: doubling the input at most doubles the work', () => {
    for (const [, unit] of ADVERSARIAL) {
      const half = unit.repeat(Math.ceil(250_000 / unit.length));
      const full = half + half;
      expect(scan(full), unit).toBeLessThanOrEqual(2 * scan(half) + 64);
    }
  });

  it('cbad68d4 AC1: a 1 MB page of many COMPLETE blocks and tags is also linear (the memo does not only help failures)', () => {
    const unit = '<script>a</script><style>b</style><!-- c --><p>text</p><meta name="description" content="d"><br>';
    const html = unit.repeat(Math.ceil(WEB_FETCH_MAX_BYTES / unit.length));
    expect(scan(html)).toBeLessThanOrEqual(MAX_PASSES * html.length);
  });

  it('cbad68d4 AC1: metaContent is a single pass for both names: a 1 MB run of meta tags with no match is one scan, not one per name', () => {
    const html = '<meta charset="utf-8">'.repeat(Math.ceil(WEB_FETCH_MAX_BYTES / 22));
    expect(scan(html)).toBeLessThanOrEqual(MAX_PASSES * html.length);
  });
});

describe('cbad68d4 AC3: the bound has teeth (negative control)', () => {
  // `memoize:false` is the former behaviour: every unterminated opener rescans to end-of-input.
  const MEMO_SENSITIVE = ['<script ', '<<<<', '<!--', '<meta ', '<style><script ', '<noscript <template <head '];

  it.each(MEMO_SENSITIVE)('cbad68d4 AC3: with the memo disabled, %s at 24 KB exceeds the linear bound; with it enabled it does not', (unit) => {
    const html = unit.repeat(Math.ceil(24_000 / unit.length));
    const on: IExtractStats = { scanned: 0 };
    const off: IExtractStats = { scanned: 0 };
    const withMemo = extractHtml(html, on);
    const withoutMemo = extractHtml(html, off, { memoize: false });
    expect(withoutMemo).toEqual(withMemo); // same output, different cost
    expect(on.scanned).toBeLessThanOrEqual(MAX_PASSES * html.length);
    expect(off.scanned).toBeGreaterThan(MAX_PASSES * html.length); // the assertion in AC1 would be red for this implementation
  });

  it('cbad68d4 AC3: the work counter is deterministic (same input, same number)', () => {
    const html = '<script '.repeat(1000);
    expect(scan(html)).toBe(scan(html));
  });
});
