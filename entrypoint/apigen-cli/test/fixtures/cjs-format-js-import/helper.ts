// Sibling module reached only through a `.js`-extension specifier (see index.ts).
// On disk this is `helper.ts` — there is no `helper.js` anywhere in this fixture.
export function buildGreeting(name: string): string {
  return `hello ${name}`;
}
