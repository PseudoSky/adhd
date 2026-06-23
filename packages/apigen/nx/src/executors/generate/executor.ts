import { ExecutorContext } from '@nx/devkit'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

  const cliArgs = [
    'generate',
    '--source', sourceFile,
    '--type', schema.type,
    '--out-dir', outDir,
  ]

  if (schema.exportMode) cliArgs.push('--export', schema.exportMode)
  for (const [k, v] of Object.entries(schema.options ?? {})) {
    cliArgs.push('--opt', `${k}=${v}`)
  }

  // Prefer the locally-built bin inside the monorepo (no publish/link required); fall back to
  // 'npx @adhd/apigen-cli' for standalone consumers using the published binary.
  const localBin = path.join(context.root, 'dist/packages/apigen/cli/index.js')
  const [cmd, args] = existsSync(localBin)
    ? ['node', [localBin, ...cliArgs]]
    : ['npx', ['@adhd/apigen-cli', ...cliArgs]]

  try {
    execFileSync(cmd as string, args as string[], { stdio: 'inherit', cwd: context.root })
    return { success: true }
  } catch {
    return { success: false }
  }
}
