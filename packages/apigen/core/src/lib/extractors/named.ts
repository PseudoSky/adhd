import { type SourceFile } from 'ts-morph'

/** Metadata for a single extracted function. */
export type FnMeta = {
  name: string
  params: { name: string; type: string; optional: boolean }[]
  returnType: string
}

/**
 * Mode 1: enumerate exported function declarations + exported function-valued consts.
 * Silently skips non-function exports (e.g. `export const VERSION = '1.0.0'`).
 */
export function extractNamed(sf: SourceFile): FnMeta[] {
  const result: FnMeta[] = []

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue
    result.push({
      name: fn.getName() ?? '',
      params: fn.getParameters().map(p => ({
        name: p.getName(),
        type: p.getType().getText(),
        optional: p.isOptional() || p.hasInitializer(),
      })),
      returnType: fn.getReturnType().getText(),
    })
  }

  for (const decl of sf.getVariableDeclarations()) {
    // Only pick up exported const declarations
    const statement = decl.getVariableStatement()
    if (!statement?.isExported()) continue

    const init = decl.getInitializer()
    if (!init) continue
    const kindName = init.getKindName()
    if (!['ArrowFunction', 'FunctionExpression'].includes(kindName)) continue

    const varType = decl.getType()
    const sigs = varType.getCallSignatures()
    if (sigs.length === 0) continue

    const sig = sigs[0]
    result.push({
      name: decl.getName(),
      params: sig.getParameters().map(p => {
        const decls = p.getDeclarations()
        const paramDecl =
          decls.length > 0 && decls[0].getKindName() === 'Parameter'
            ? (decls[0] as import('ts-morph').ParameterDeclaration)
            : null
        const optional =
          p.isOptional() ||
          (paramDecl?.hasInitializer() ?? false) ||
          (paramDecl?.hasQuestionToken?.() ?? false)
        return {
          name: p.getName(),
          type: p.getTypeAtLocation(decl).getText(),
          optional,
        }
      }),
      returnType: sig.getReturnType().getText(),
    })
  }

  return result
}
