import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeSchemas, type Operation } from '@adhd/apigen-core-client';
import { policyOperations, type IPolicyCtx } from '@adhd/policy-core-client';
import { extractPolicyOperations, locateClientApi, policyDistDir } from './ir';

/**
 * Inlines every `$ref` against the `definitions` / `$defs` collected from the
 * whole schema, then drops them. apigen run-mode dispatch cannot resolve a
 * `$ref` (its resolver is a throwing stub), so no `$ref` may reach
 * `composeSchemas` / `dispatch`. Same algorithm as
 * `entrypoint/backlog/src/server.ts` (`dereferenceSchema`); the policy
 * operation types are acyclic, so this terminates.
 */
function dereferenceSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const definitions: Record<string, unknown> = {};
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
          if (!(name in definitions)) definitions[name] = def;
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      collect(value);
    }
  };
  collect(schema);
  collect(definitions);
  if (Object.keys(definitions).length === 0) return schema;

  const inline = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, seen));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/(?:definitions|\$defs)\//, '');
      if (seen.has(name) || !(name in definitions)) return {};
      return inline(definitions[name], new Set([...seen, name]));
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      out[key] = inline(value, seen);
    }
    return out;
  };
  return inline(schema, new Set());
}

/** The version in this package's own `package.json` (next to the bundle once published, one level up from `dist/` in the repo). */
export function readPolicyVersion(): string {
  for (const candidate of [join(policyDistDir(), 'package.json'), join(policyDistDir(), '..', 'package.json')]) {
    try {
      if (existsSync(candidate)) {
        const version = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }).version;
        if (typeof version === 'string') return version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

/**
 * Builds the apigen-ready package descriptor for the client's operations.
 * `ctx` may be a ready context or a thunk; `createClient` calls the thunk
 * FRESH on every dispatch, so `--help` and argument errors never resolve a
 * policy file (IN-14). The operations and schemas are derived from the
 * declarations alone and never touch `ctx`.
 */
export async function buildPolicyPackage(ctx: IPolicyCtx | (() => IPolicyCtx | Promise<IPolicyCtx>)): Promise<{
  pkg: {
    id: string;
    version: string;
    schemas: ReturnType<typeof composeSchemas>;
    importPath: string;
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: () => Promise<IPolicyCtx>;
  };
  operations: Operation[];
}> {
  const getCtx: () => IPolicyCtx | Promise<IPolicyCtx> = typeof ctx === 'function' ? ctx : () => ctx;
  const operations = await extractPolicyOperations();
  const generated = {
    metadata: { namespace: 'policy', phase: '' },
    schemas: Object.fromEntries(
      operations
        .filter((op) => op.kind === 'action')
        .map((op) => [
          op.path[op.path.length - 1]?.raw ?? '',
          {
            input: dereferenceSchema(op.input) as Record<string, unknown>,
            output: dereferenceSchema(op.output) as Record<string, unknown>,
            hasCtx: op.hasCtx,
            safe: op.safe,
          },
        ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  return {
    pkg: {
      id: 'policy',
      version: readPolicyVersion(),
      schemas,
      importPath: locateClientApi()?.apiDts ?? '@adhd/policy-core-client',
      fns: policyOperations as unknown as Record<string, (...args: unknown[]) => unknown>,
      createClient: async () => getCtx(),
    },
    operations,
  };
}
