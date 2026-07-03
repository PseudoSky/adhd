import { workspaceRoot } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';

export interface ResolveInfo {
  workspace: string;
  packageRoot: string;
  packageName: string;
}

export function getPackageInfo(): ResolveInfo {
  // 1. Get the directory of the file that called this function
  // Handles situations where Node's execution context shifts
  const targetDir = process.cwd();

  let currentDir = targetDir;

  // 2. Traverse upward to find the closest package.json
  while (currentDir !== path.parse(currentDir).root) {
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        
        return {
          workspace: workspaceRoot,
          packageRoot: currentDir,
          packageName: packageJson.name || path.basename(currentDir),
        };
      } catch {
        // Fallback if package.json is malformed
        break;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  // 3. Fallback if no package.json is found
  return {
    workspace: workspaceRoot,
    packageRoot: workspaceRoot,
    packageName: 'workspace-root',
  };
}
