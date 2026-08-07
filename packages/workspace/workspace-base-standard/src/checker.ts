/**
 * checker.ts — pure, filesystem-only project standards checker.
 *
 * `checkProject` never shells out and never imports `@nx/devkit`: it reads
 * `project.json` as plain JSON (that file is plain data — parsing it
 * requires no nx-awareness) and the required doc files via `node:fs`. This
 * keeps the checker usable from any context (git hook, CLI, MCP tool, unit
 * test) without paying for an Nx project-graph load.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requiredFilesFor, requiredTargetsFor, REQUIRED_FILE_SECTION_MARKERS, type RequiredFile } from './required';

export interface CheckResult {
  rule: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface CheckProjectOptions {
  /**
   * `'dev'` (default) downgrades an unmodified generator placeholder to a
   * warning; `'ci'` treats it as an error.
   */
  mode?: 'dev' | 'ci';
}

/**
 * Builds the exact placeholder content the `workspace-codegen-nx` `base`
 * generator's `ensureReadme` stamper writes for a freshly-scaffolded
 * package, so `checkProject` can detect an unmodified README. Mirrors
 * `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts`'s
 * `ensureReadme` verbatim. Only `README.md` has a known generator stamper
 * today — the other required files have no placeholder-detection case (a
 * missing file is simply `error`, not a placeholder match), but this
 * function is the single seam future stampers (`PKG-WS-NX-ADAPTER`) plug
 * into.
 */
function placeholderTemplateFor(file: RequiredFile, projectName: string): string | null {
  if (file === 'README.md') {
    return `# @adhd/${projectName}\n\n> TODO: one-line description of \`${projectName}\`.\n\n\`\`\`bash\nnpm install @adhd/${projectName}\n\`\`\`\n`;
  }
  return null;
}

/**
 * Reads `<projectDir>/project.json`'s bare `name` field. Returns `null` if
 * the file is missing or has no `name` (the placeholder-detection check is
 * simply skipped in that case — a missing/malformed `project.json` is
 * reported separately by the target-presence check).
 */
function readProjectName(projectDir: string): string | null {
  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    return typeof parsed?.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Runs the workspace-standard checks against a real, absolute project
 * directory. Pure filesystem reads — no nx, no shelling out.
 */
export function checkProject(projectDir: string, tags: string[], opts: CheckProjectOptions = {}): CheckResult[] {
  const mode = opts.mode ?? 'dev';
  const results: CheckResult[] = [];

  const projectName = readProjectName(projectDir);

  // (a) + placeholder detection, and (b) required-section markers.
  for (const file of requiredFilesFor(tags) as RequiredFile[]) {
    const filePath = join(projectDir, file);

    if (!existsSync(filePath)) {
      results.push({
        rule: 'required-file-present',
        severity: 'error',
        message: `Required file "${file}" is missing from ${projectDir}.`,
      });
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');

    // Placeholder-stamp detection.
    if (projectName) {
      const placeholder = placeholderTemplateFor(file, projectName);
      if (placeholder !== null && content === placeholder) {
        results.push({
          rule: 'required-file-not-placeholder',
          severity: mode === 'ci' ? 'error' : 'warn',
          message: `"${file}" still contains the unmodified generator placeholder — replace it with real content.`,
        });
      }
    }

    // Required-section requirement.
    const requirement = REQUIRED_FILE_SECTION_MARKERS[file];
    if (requirement.kind === 'marker') {
      if (!content.includes(requirement.marker)) {
        results.push({
          rule: 'required-section-present',
          severity: 'error',
          message: `"${file}" is missing the required section marker "${requirement.marker}".`,
        });
      }
    } else if (requirement.kind === 'non-empty') {
      if (content.trim().length === 0) {
        results.push({
          rule: 'required-section-present',
          severity: 'error',
          message: `"${file}" exists but is empty — it must contain at least freeform content.`,
        });
      }
    }
    // requirement.kind === 'none' -> existence alone is sufficient.
  }

  // (c) required targets — project.json is plain JSON, no nx import needed.
  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    results.push({
      rule: 'required-target-present',
      severity: 'error',
      message: `Cannot check required targets: ${projectJsonPath} is missing.`,
    });
  } else {
    let projectJson: { targets?: Record<string, unknown> } = {};
    try {
      projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    } catch (err) {
      results.push({
        rule: 'required-target-present',
        severity: 'error',
        message: `${projectJsonPath} is not valid JSON: ${(err as Error).message}`,
      });
      projectJson = {};
    }
    const targets = projectJson.targets ?? {};
    for (const target of requiredTargetsFor(tags)) {
      if (!(target in targets)) {
        results.push({
          rule: 'required-target-present',
          severity: 'error',
          message: `Required target "${target}" is missing from ${projectJsonPath}. Note: targets inferred by Nx plugins (e.g. via nx.json \`plugins\`) will not appear in this static project.json read — this check only sees explicitly-declared targets.`,
        });
      }
    }
  }

  return results;
}
