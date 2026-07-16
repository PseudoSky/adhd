import { type SourceFile } from 'ts-morph';
import type { SchemaNode } from '@adhd/apigen-base-logical';
import { validateSchemaRefs } from '@adhd/apigen-base-logical';
import type { GenerateSchemasOptions, GeneratedSchemas } from './types';
import { extractNamed } from './extractors/named';
import { extractDefault } from './extractors/default-export';
import { extractNamedObject } from './extractors/named-object';
import { buildSchema } from './schema-builders/ts-json-schema';
import { createExtractionSession, internalSession } from './extraction-session';
import { applyParamDefault } from './extractors/param-defaults';

/**
 * Reads a TypeScript source file and returns `GeneratedSchemas` — domain schemas only,
 * no middleware envelope. Supports three extraction modes: named, default, named-object.
 *
 * Pass `opts.session` (see `createExtractionSession`) to share the ts-morph
 * Project, built generators, and computed schemas with other extraction calls
 * in the same run — e.g. the orchestrator extracts and composes the same file,
 * and the shared session turns the second pass into cache hits.
 *
 * @param opts - Extraction options including source file path, export mode, namespace, phase
 */
export async function generateSchemas(
  opts: GenerateSchemasOptions
): Promise<GeneratedSchemas> {
  const {
    sourceFile: filePath,
    exportMode = { type: 'named' },
    namespace = '',
    phase = '',
    tsconfig,
  } = opts;

  const ownsSession = opts.session === undefined;
  const session = internalSession(opts.session ?? createExtractionSession());
  try {
    // When a tsconfig is supplied, honor its compilerOptions for type resolution but
    // still avoid pulling its whole `include` graph in — we only need `filePath`.
    const project = session.projectFor(tsconfig);
    const sf: SourceFile = session.sourceFileFor(filePath, tsconfig);

    type FnParam = {
      name: string;
      type: string;
      optional: boolean;
      defaultValue?: string;
    };
    type FnInfo = { name: string; params: FnParam[]; returnType: string };

    let fns: FnInfo[];
    if (exportMode.type === 'named') {
      fns = extractNamed(sf);
    } else if (exportMode.type === 'default') {
      fns = extractDefault(sf);
    } else {
      fns = extractNamedObject(sf, exportMode.name);
    }

    const schemas: GeneratedSchemas['schemas'] = {};

    for (const fn of fns) {
      // [inv:ctx-name-only] — filter ctx by name only, no type checking.
      // A first param named `ctx` is excluded from the schema but RECORDED via
      // `hasCtx` so dispatch() can re-inject it as the first arg (BUG-APIGEN-001).
      const hasCtx = fn.params.length > 0 && fn.params[0].name === 'ctx';
      const domainParams = fn.params.filter((p) => p.name !== 'ctx');
      const required = domainParams
        .filter((p) => !p.optional)
        .map((p) => p.name);

      const properties: Record<string, unknown> = {};
      for (const p of domainParams) {
        const built = await buildSchema(project, sf, p.type, tsconfig, session);
        // buildSchema's results are memoized by reference (session/persistent
        // caches) and MUST be treated as immutable by callers — shallow-clone
        // before mutating so per-param `default`/`description` never leaks
        // across other params or functions sharing the same type text.
        const propSchema: Record<string, unknown> = { ...built };
        // BUG-APIGEN-018: surface the TS initializer / JSDoc @default as both
        // the native JSON-Schema `default` keyword and a human-readable note
        // in `description`.
        if (p.defaultValue !== undefined) {
          applyParamDefault(propSchema, p.defaultValue);
        }
        properties[p.name] = propSchema;
      }

      // Unwrap Promise<T> → T for the output schema
      const rawReturn = fn.returnType;
      const resolvedReturn = rawReturn.replace(/^Promise<(.+)>$/, '$1').trim();
      const outputSchema = await buildSchema(
        project,
        sf,
        resolvedReturn,
        tsconfig,
        session
      );

      schemas[fn.name] = {
        input: { type: 'object', properties, required } as Record<
          string,
          unknown
        >,
        output: outputSchema,
        ...(hasCtx ? { hasCtx: true } : {}),
      };
    }

    // BUG-APIGEN-CORE-001: validate all $ref values against the accumulated
    // $defs dictionary so unresolvable refs are caught at generation time,
    // not at first runtime invocation.
    const allDefs: Record<string, SchemaNode> = {};
    const collectDefs = (node: Record<string, unknown>): void => {
      const defs = node['$defs'] as Record<string, SchemaNode> | undefined;
      if (defs) Object.assign(allDefs, defs);
    };
    for (const fnSchema of Object.values(schemas)) {
      collectDefs(fnSchema.input);
      collectDefs(fnSchema.output);
    }
    // Only run validation when there are $defs to resolve against; a schema
    // with $ref but no $defs at all is a structural problem that the
    // orchestrator will catch when composing the final descriptor.
    if (Object.keys(allDefs).length > 0) {
      for (const [fnName, fnSchema] of Object.entries(schemas)) {
        try {
          validateSchemaRefs(fnSchema.input, allDefs);
          validateSchemaRefs(fnSchema.output, allDefs);
        } catch (err) {
          throw new Error(
            `[apigen-core-client] Schema validation failed for function "${fnName}": ${(err as Error).message}`
          );
        }
      }
    }
    return { metadata: { namespace, phase }, schemas };
  } finally {
    if (ownsSession) session.dispose();
  }
}
