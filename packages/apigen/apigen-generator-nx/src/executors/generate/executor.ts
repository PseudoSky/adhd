import { ExecutorContext } from '@nx/devkit';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface GenerateExecutorSchema {
  source: string;
  type: string;
  outDir: string;
  exportMode?: string;
  options?: Record<string, string>;
}

export default async function generateExecutor(
  schema: GenerateExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectName = context.projectName;
  if (!projectName) throw new Error('projectName is required');
  // Nx 23 removed `ExecutorContext.workspace.projects`; the project graph's
  // roots now live on `projectsConfigurations`. Reading the removed field
  // yielded an empty root, so `schema.source` resolved against the WORKSPACE
  // root instead of the project root (`src/api.ts` instead of
  // `entrypoint/dispatch-cli/src/api.ts`). Fall back to `workspace` so an
  // older devkit still works.
  const projectRoot =
    context.projectsConfigurations?.projects?.[projectName]?.root ??
    context.workspace?.projects?.[projectName]?.root ??
    '';
  const sourceFile = path.resolve(context.root, projectRoot, schema.source);
  const outDir = path.resolve(context.root, schema.outDir);

  const cliArgs = [
    'generate',
    '--source',
    sourceFile,
    '--type',
    schema.type,
    '--out-dir',
    outDir,
  ];

  if (schema.exportMode) cliArgs.push('--export', schema.exportMode);
  for (const [k, v] of Object.entries(schema.options ?? {})) {
    cliArgs.push('--opt', `${k}=${v}`);
  }

  // Prefer the locally-built bin inside the monorepo (no publish/link required); fall back to
  // 'npx @adhd/apigen-cli' for standalone consumers using the published binary.
  const localBin = path.join(context.root, 'entrypoint/apigen-cli/dist/index.js');
  const [cmd, args] = existsSync(localBin)
    ? ['node', [localBin, ...cliArgs]]
    : ['npx', ['@adhd/apigen-cli', ...cliArgs]];

  try {
    execFileSync(cmd as string, args as string[], {
      stdio: 'inherit',
      cwd: context.root,
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}
