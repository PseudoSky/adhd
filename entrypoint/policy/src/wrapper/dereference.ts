/**
 * Inlines every `$ref` against the `definitions` / `$defs` collected from the
 * whole schema, then drops them. apigen run-mode dispatch cannot resolve a
 * `$ref` (its resolver is a throwing stub), so no `$ref` may reach
 * `composeSchemas` / `dispatch`.
 *
 * Same algorithm as `entrypoint/backlog/src/server.ts` (`dereferenceSchema`)
 * but strict: a `$ref` that is not a local `#/definitions/<name>` or
 * `#/$defs/<name>` pointer to a collected definition, and a reference cycle,
 * throw an `Error` naming the schema path of the offending `$ref` (the backlog
 * copy silently substitutes `{}`, which would turn a broken schema into one
 * that accepts anything). The duplicate is tracked for extraction into
 * `@adhd/apigen-core-client` once that package exposes a schema-utils module.
 */
export function dereferenceSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const definitions = new Map<string, unknown>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of ['definitions', '$defs']) {
      const defs = obj[key];
      if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
        for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
          if (!definitions.has(name)) definitions.set(name, def);
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      collect(value);
    }
  };
  collect(schema);
  collect([...definitions.values()]);

  const DEFINITION_POINTER = /^#\/(?:definitions|\$defs)\/(.+)$/;
  const pathLabel = (path: readonly string[]): string => (path.length === 0 ? '<root>' : path.join('.'));

  const inline = (node: unknown, chain: readonly string[], path: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => inline(item, chain, [...path, String(index)]));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string') {
      const match = DEFINITION_POINTER.exec(ref);
      const name = match?.[1] === undefined ? undefined : match[1].replace(/~1/g, '/').replace(/~0/g, '~');
      if (name === undefined || !definitions.has(name)) {
        throw new Error(`@adhd/policy: unresolved $ref "${ref}" at ${pathLabel(path)}`);
      }
      if (chain.includes(name)) {
        throw new Error(`@adhd/policy: cyclic $ref "${ref}" at ${pathLabel(path)} (${[...chain, name].join(' -> ')})`);
      }
      return inline(definitions.get(name), [...chain, name], path);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      out[key] = inline(value, chain, [...path, key]);
    }
    return out;
  };
  return inline(schema, [], []);
}
