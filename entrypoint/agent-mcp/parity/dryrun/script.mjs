// Dry-run only: the scripted "model". Straight-line async code over an `io` adapter, so the SAME behaviour drives
// the fake claude CLI (arms A and B) and the fake Anthropic server (arm C). It reads facts out of REAL tool results
// (regexes over what the real servers returned) and performs the REAL work through real tools, so it exercises the
// real plumbing end to end and its output is judged by the real hidden test suite.
// io: { cwd(), call(kind, args) -> Promise<string>, dispatchMany([{name, role, prompt}]) -> Promise<string[]>,
//       canDispatch, canWeb, history: string }
//   kind: shell {argv, line} | read {path} | write {path, content} | edit {path, old, new} | ticket {} | web {url}
/** Last match of a (global) regex; capture group 1 when the pattern has one, else the whole match. */
const last = (s, re) => { const all = [...String(s).matchAll(re)]; if (!all.length) return null; const m = all[all.length - 1]; return m[1] ?? m[0]; };
/** Strip `cat -n` style prefixes ("   203\t") that the native Read tool adds. */
export const unnumber = (t) => String(t).split('\n').map((l) => l.replace(/^\s*\d+[\t→]/, '')).join('\n');

export const ROLE_RE = /\[r2-role:([a-z-]+)\]/;
const tag = (role) => `[r2-role:${role}]`;

export async function runRole({ role, phase, io, mode = 'ideal' }) {
  const cwd = await io.cwd();
  const P = (f) => `${cwd}/${f}`;
  const rd = async (f) => unnumber(await io.call('read', { path: P(f) }));

  if (role === 'lookup') {
    const co = await rd('CODEOWNERS');
    const m = co.match(/src\/shipping\.js\s+@(team-[0-9a-f]{6})/);
    return m ? `${m[1]}` : 'owner not found';
  }
  if (role === 'impl') {
    // the prompt carries the ticket facts the parent extracted
    const prompt = io.prompt || '';
    const T = last(prompt, /threshold (\d+)/g), R = last(prompt, /rate (\d+\.\d\d)/g);
    await rd('src/shipping.js'); await rd('src/summary.js');
    await io.call('write', { path: P('src/shipping.js'), content: `export function shippingCost(subtotal) {\n  return subtotal >= ${T} ? 0 : ${R};\n}\n` });
    // a careful maintainer keeps the file's CRLF line endings; mode 'hazards' (a sloppy rewrite) normalises them to LF
    const eol = mode === 'hazards' ? '\n' : '\r\n';
    const summary = ["import { computeTotal, subtotalOf } from './checkout.js';", "import { roundCents } from './format.js';", "import { shippingCost } from './shipping.js';", '', '// checkoutSummary is the single entry point the storefront calls for an order overview.', 'export function checkoutSummary(items, options = {}) {', '  const subtotal = subtotalOf(items);', '  const total = computeTotal(items, options);', '  const shipping = shippingCost(subtotal);', '  return { subtotal, total, shipping, grandTotal: roundCents(total + shipping) };', '}', ''].join(eol);
    await io.call('write', { path: P('src/summary.js'), content: summary });
    return `Implemented shippingCost (threshold ${T}, flat rate ${R}) and extended checkoutSummary.`;
  }
  if (role === 'docs') {
    const prompt = io.prompt || '';
    const T = last(prompt, /threshold (\d+)/g), R = last(prompt, /rate (\d+\.\d\d)/g), ticket = last(prompt, /TCK-[0-9a-f]{8}/g);
    const heading = last(prompt, /Source heading: ([^\n]+)/g);
    let owner = null;
    if (io.canDispatch) { const [r] = await io.dispatchMany([{ name: 'worker', role: 'lookup', prompt: `${tag('lookup')} Look up which team owns src/shipping.js in the CODEOWNERS file of the current directory and reply with its handle.` }]); owner = last(r, /team-[0-9a-f]{6}/g); }
    else { const m = (await rd('CODEOWNERS')).match(/src\/shipping\.js\s+@(team-[0-9a-f]{6})/); owner = m && m[1]; }
    await io.call('mkdir', { path: P('docs') });
    await io.call('write', { path: P('docs/shipping.md'), content: `Source: ${heading || '(page not fetched)'}\n\n# Shipping\n\nOrders with a subtotal of ${T}.00 or more ship free; smaller orders pay a flat shipping rate of ${R}.\n\nOwner: @${owner}\n` });
    const cl = await rd('CHANGELOG.md');
    await io.call('edit', { path: P('CHANGELOG.md'), old: '## [Unreleased]\n', new: `## [Unreleased]\n\n- Free shipping for large orders (${ticket}).\n` });
    return `Docs and changelog written. Owner: ${owner}. (${cl.length} bytes of changelog read)`;
  }
  if (role === 'examples') {
    const prompt = io.prompt || '';
    const T = last(prompt, /subtotal >= (\d+)/g), R = last(prompt, /\? 0 : (\d+\.\d\d)/g);
    const cur = await rd('examples/usage.md');
    await io.call('write', { path: P('examples/usage.md'), content: `${cur.trimEnd()}\n\n## Shipping\n\n\`\`\`js\nimport { shippingCost } from '../src/shipping.js';\nimport { checkoutSummary } from '../src/summary.js';\n\nshippingCost(${Number(T) - 1});   // ${R}\nshippingCost(${T});       // 0\ncheckoutSummary([{ price: 10, qty: 1 }]);   // { subtotal, total, shipping: ${R}, grandTotal }\n\`\`\`\n` });
    return 'examples/usage.md updated.';
  }

  if (role === 'parent' && phase === 1) {
    const first = await io.call('shell', { argv: ['make', 'test'], line: 'make test', directory: cwd });
    const failedBefore = last(first, /(?:^|\s)fail (\d+)/gm);
    await io.call('shell', { argv: ['grep', '-rn', 'applyDiscount', 'src'], line: 'grep -rn applyDiscount src', directory: cwd });
    const src = await rd('src/checkout.js');
    const BUG = 'discounted + subtotal * taxRate';
    if (mode !== 'no-fix' && mode !== 'lie') {
      if (!src.includes(BUG)) throw new Error('script: buggy line not found in checkout.js');
      if (mode === 'hazards') {
        // sloppy: replace every occurrence, including the frozen legacyInvoiceTotal copy
        await io.call('write', { path: P('src/checkout.js'), content: src.split(BUG).join('discounted + tax') });
      } else {
        // the line occurs twice (computeTotal and the frozen legacyInvoiceTotal): anchor the edit on computeTotal's own text
        const a = src.indexOf('export function computeTotal'), b = src.indexOf(BUG, a) + BUG.length;
        const oldText = src.slice(a, b);
        await io.call('edit', { path: P('src/checkout.js'), old: oldText, new: oldText.replace(BUG, 'discounted + tax') });
      }
    }
    const ticket = await io.call('ticket', {});
    const id = last(ticket, /TCK-[0-9a-f]{8}/g), T = last(ticket, /at least (\d+)\.00/g), R = last(ticket, /flat shipping rate of (\d+\.\d\d)/g);
    let heading = null;
    if (io.canWeb) { const w = await io.call('web', { url: 'https://example.com' }); const m = w.match(/<h1>([^<]+)<\/h1>/); heading = m ? m[1] : null; }
    const facts = `ticket ${id}, threshold ${T}, flat shipping rate ${R}.`;
    const items = [{ name: 'worker', role: 'impl', prompt: `${tag('impl')} Implement shippingCost(subtotal) in src/shipping.js for ${facts} Free shipping at or above the threshold; also extend checkoutSummary() in src/summary.js with shipping and grandTotal (total + shipping, rounded to cents).` },
      { name: 'worker', role: 'docs', prompt: `${tag('docs')} Write docs/shipping.md for ${facts} Source heading: ${heading ?? ''}\nAdd a CHANGELOG.md entry under [Unreleased] mentioning ${id}. Name the owner team from CODEOWNERS.` }];
    let replies;
    if (mode === 'serial') { replies = []; for (const it of items) replies.push((await io.dispatchMany([it]))[0]); } else replies = await io.dispatchMany(items);
    const owner = last(replies[1], /team-[0-9a-f]{6}/g);
    const second = await io.call('shell', { argv: ['make', 'test'], line: 'make test', directory: cwd });
    const green = /(?:^|\s)fail 0\b/m.test(second);
    const j = { root_cause: 'computeTotal added tax on the pre-discount subtotal instead of the discounted amount, so every discounted order was overcharged.', ticket: id, owner: `@${owner}`, web_heading: heading, flat_shipping_total: Number(R), tests_pass: mode === 'lie' ? true : green, files_changed: ['src/checkout.js', 'src/shipping.js', 'src/summary.js', 'docs/shipping.md', 'CHANGELOG.md'], };
    const tail = mode === 'prose-after' ? '\nLet me know if you need anything else.' : '';
    return `Fixed the failing tests (${failedBefore ?? '?'} failures before) and shipped ${id}.\n${JSON.stringify(j)}${tail}`;
  }
  if (role === 'parent' && phase === 2) {
    let rate = last(io.history, /carrier rate of (\d+\.\d\d)/g);
    if (!rate) rate = last(await io.call('ticket', {}), /carrier rate of (\d+\.\d\d)/g);       // not recalled -> re-explore, as a real model would
    const firstFile = (last(io.history, /"files_changed":\s*\["([^"]+)"/g)) || 'unknown';
    const ship = await rd('src/shipping.js');
    await io.call('edit', { path: P('src/shipping.js'), old: '  return subtotal >=', new: '  if (!(subtotal > 0)) return 0;\n  return subtotal >=' });
    const [r] = await io.dispatchMany([{ name: 'worker', role: 'examples', prompt: `${tag('examples')} Update examples/usage.md with examples of shippingCost and checkoutSummary, based on this implementation by the first worker:\n${ship}` }]);
    const second = await io.call('shell', { argv: ['make', 'test'], line: 'make test', directory: cwd });
    const green = /(?:^|\s)fail 0\b/m.test(second);
    const j = { empty_cart_handled: true, tests_pass: green, carrier_rate: Number(rate), first_file_fixed: firstFile, examples_updated: /updated/.test(r) };
    return `Empty carts now cost nothing.\n${JSON.stringify(j)}`;
  }
  throw new Error(`unknown role ${role}/${phase}`);
}
