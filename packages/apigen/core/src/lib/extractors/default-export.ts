import { type SourceFile } from 'ts-morph'
import type { FnMeta } from './named'

/**
 * Mode 2: read `export default { ... }` object literal; each property whose
 * value is a function becomes an endpoint. Skips non-function properties.
 */
export function extractDefault(sf: SourceFile): FnMeta[] {
  const result: FnMeta[] = []

  const defaultExport = sf.getDefaultExportSymbol()
  if (!defaultExport) return result

  const decls = defaultExport.getDeclarations()
  if (decls.length === 0) return result

  // The default export expression type gives us the object type
  const exportAssign = sf.getExportAssignment(a => !a.isExportEquals())
  if (!exportAssign) return result

  const objType = exportAssign.getExpression().getType()

  for (const prop of objType.getProperties()) {
    const propType = prop.getTypeAtLocation(exportAssign)
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
          type: p.getTypeAtLocation(exportAssign).getText(),
          optional,
        }
      }),
      returnType: sig.getReturnType().getText(),
    })
  }

  return result
}
