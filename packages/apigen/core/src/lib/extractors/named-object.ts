import { type SourceFile } from 'ts-morph'
import type { FnMeta } from './named'

/**
 * Mode 3: find `export const <name> = { ... }`; each property whose value
 * is a function becomes an endpoint. Skips non-function properties.
 */
export function extractNamedObject(sf: SourceFile, exportName: string): FnMeta[] {
  const result: FnMeta[] = []

  const varDecl = sf
    .getVariableDeclarations()
    .find(v => v.getName() === exportName)

  if (!varDecl) {
    console.error(`[apigen-core] No variable "${exportName}" in source`)
    return result
  }

  const objType = varDecl.getType()

  for (const prop of objType.getProperties()) {
    const propType = prop.getTypeAtLocation(varDecl)
    const sigs = propType.getCallSignatures()
    if (sigs.length === 0) continue

    const sig = sigs[0]
    result.push({
      name: prop.getName(),
      params: sig.getParameters().map(p => {
        const pDecls = p.getDeclarations()
        const paramDecl =
          pDecls.length > 0 && pDecls[0].getKindName() === 'Parameter'
            ? (pDecls[0] as import('ts-morph').ParameterDeclaration)
            : null
        const optional =
          p.isOptional() ||
          (paramDecl?.hasInitializer() ?? false) ||
          (paramDecl?.hasQuestionToken?.() ?? false)
        return {
          name: p.getName(),
          type: p.getTypeAtLocation(varDecl).getText(),
          optional,
        }
      }),
      returnType: sig.getReturnType().getText(),
    })
  }

  return result
}
