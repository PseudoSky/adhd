import { ExecutorContext } from '@nx/devkit'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

export interface GenerateExecutorSchema {
  source: string
  type: string
  outDir: string
  exportMode?: string
  options?: Record<string, string>
}

export default async function generateExecutor(
  schema: GenerateExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectRoot = context.workspace?.projects[context.projectName!]?.root ?? ''
  const sourceFile = path.resolve(context.root, projectRoot, schema.source)
  const outDir = path.resolve(context.root, schema.outDir)

  // 'npx @adhd/apigen-cli' resolves via workspace node_modules/.bin in the monorepo,
  // and via the published binary when used as a standalone consumer.
  const args = [
    '@adhd/apigen-cli', 'generate',
    '--source', sourceFile,
    '--type', schema.type,
    '--out-dir', outDir,
  ]

  if (schema.exportMode) args.push('--export', schema.exportMode)
  for (const [k, v] of Object.entries(schema.options ?? {})) {
    args.push('--opt', `${k}=${v}`)
  }

  try {
    execFileSync('npx', args, { stdio: 'inherit', cwd: context.root })
    return { success: true }
  } catch {
    return { success: false }
  }
}
