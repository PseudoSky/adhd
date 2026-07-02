/**
 * validate.ts — Structural validators for dag.json and snapshot output.
 */

import type {
  DagJson,
  DagSnapshot,
  MilestoneStatus,
  OperationStatus,
  ValidationError,
  ValidationResult,
  ShapeOpType,
} from './types.js';
import { isValidOpForKind } from './types.js';

const VALID_MILESTONE_STATUSES = new Set<MilestoneStatus>([
  'pending',
  'pending-surfaced',
  'in_progress',
  'complete',
  'failed',
  'skipped',
]);
const VALID_OPERATION_STATUSES = new Set<OperationStatus>([
  'pending',
  'in_progress',
  'complete',
  'failed',
  'skipped',
]);
const VALID_OPERATION_TYPES = new Set(['automated', 'tool-call', 'generative']);
const VALID_SHAPE_KINDS = new Set([
  'function',
  'interface',
  'type',
  'class',
  'enum',
  'const',
  'script',
  'config',
  'env',
  'schema',
  'manifest',
  'doc',
  'structured-output',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function err(path: string, message: string, value?: unknown): ValidationError {
  return { path, message, value };
}

function detectCycle(
  milestones: Record<string, { depends_on: string[] }>
): { slug: string }[] | null {
  const slugs = Object.keys(milestones);
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const slug of slugs) {
    inDegree.set(slug, 0);
    children.set(slug, []);
  }
  for (const slug of slugs) {
    for (const dep of milestones[slug]?.depends_on ?? []) {
      if (!milestones[dep]) continue;
      children.get(dep)?.push(slug);
      inDegree.set(slug, (inDegree.get(slug) ?? 0) + 1);
    }
  }
  const queue = slugs.filter((s) => (inDegree.get(s) ?? 0) === 0);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const slug = queue.shift();
    if (slug === undefined) continue;
    visited.add(slug);
    for (const child of children.get(slug) ?? []) {
      const d = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  if (visited.size !== slugs.length)
    return slugs.filter((s) => !visited.has(s)).map((slug) => ({ slug }));
  return null;
}

export function validateDagJson(dag: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isObject(dag))
    return { valid: false, errors: [err('', 'root must be an object')] };

  for (const field of ['description', 'problem', 'approach', 'executor']) {
    const v = dag[field];
    if (!isString(v) || (v as string).trim() === '')
      errors.push(err(field, `required string field missing/empty`, v));
  }
  if (typeof dag['schema_version'] !== 'number')
    errors.push(
      err('schema_version', 'must be a number', dag['schema_version'])
    );
  const pk = dag['plan_kind'];
  if (pk !== 'brownfield' && pk !== 'greenfield')
    errors.push(err('plan_kind', `must be "brownfield" or "greenfield"`, pk));
  if (!Array.isArray(dag['phases']))
    errors.push(err('phases', 'must be an array', dag['phases']));
  else if ((dag['phases'] as unknown[]).length === 0)
    errors.push(err('phases', 'must have at least one entry'));
  const term = dag['terminal'];
  if (!isString(term) && !Array.isArray(term))
    errors.push(err('terminal', 'must be a string or array', term));
  if (!Array.isArray(dag['dispatch_log']))
    errors.push(err('dispatch_log', 'must be an array', dag['dispatch_log']));
  if (!isObject(dag['optimization']))
    errors.push(err('optimization', 'must be an object', dag['optimization']));
  if (!isObject(dag['providers']))
    errors.push(err('providers', 'must be an object', dag['providers']));
  if (!isObject(dag['effort_max_tokens']))
    errors.push(
      err('effort_max_tokens', 'must be an object', dag['effort_max_tokens'])
    );

  const milestonesRaw = dag['milestones'];
  if (!isObject(milestonesRaw)) {
    errors.push(err('milestones', 'must be an object', milestonesRaw));
  } else {
    const milestoneKeys = Object.keys(milestonesRaw);
    if (milestoneKeys.length === 0)
      errors.push(err('milestones', 'must have at least one entry'));
    const validSlugs = new Set(milestoneKeys);

    for (const slug of milestoneKeys) {
      const m = milestonesRaw[slug];
      if (!isObject(m)) {
        errors.push(err(`milestones.${slug}`, 'must be an object', m));
        continue;
      }
      if (
        !isString(m['description']) ||
        (m['description'] as string).trim() === ''
      )
        errors.push(
          err(
            `milestones.${slug}.description`,
            'required string',
            m['description']
          )
        );
      if (!Array.isArray(m['depends_on']))
        errors.push(
          err(
            `milestones.${slug}.depends_on`,
            'must be an array',
            m['depends_on']
          )
        );
      else
        for (const dep of m['depends_on'] as unknown[]) {
          if (!isString(dep))
            errors.push(
              err(`milestones.${slug}.depends_on[]`, 'must be a string', dep)
            );
          else if (!validSlugs.has(dep))
            errors.push(
              err(`milestones.${slug}.depends_on`, `unknown milestone "${dep}"`)
            );
        }
      const phase = m['phase'];
      if (!isString(phase) || phase.trim() === '')
        errors.push(err(`milestones.${slug}.phase`, 'required string', phase));
      if (
        !isString(m['authored_by']) ||
        (m['authored_by'] as string).trim() === ''
      )
        errors.push(
          err(
            `milestones.${slug}.authored_by`,
            'required string',
            m['authored_by']
          )
        );
      const model = m['model'];
      if (
        model !== null &&
        model !== undefined &&
        !['Haiku', 'Sonnet', 'Opus'].includes(model as string)
      )
        errors.push(
          err(`milestones.${slug}.model`, 'invalid model tier', model)
        );
      const effort = m['effort'];
      if (
        effort !== null &&
        effort !== undefined &&
        !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort as string)
      )
        errors.push(
          err(`milestones.${slug}.effort`, 'invalid effort tier', effort)
        );
      if (m['two_stage'] !== undefined && typeof m['two_stage'] !== 'boolean')
        errors.push(
          err(
            `milestones.${slug}.two_stage`,
            'must be a boolean',
            m['two_stage']
          )
        );
      if (!Array.isArray(m['read_only']))
        errors.push(
          err(
            `milestones.${slug}.read_only`,
            'must be an array',
            m['read_only']
          )
        );
    }

    const cycle = detectCycle(
      milestonesRaw as Record<string, { depends_on: string[] }>
    );
    if (cycle)
      for (const { slug } of cycle)
        errors.push(err(`milestones.${slug}`, 'dependency cycle detected'));

    if (isString(term) && !validSlugs.has(term))
      errors.push(err('terminal', `unknown milestone "${term}"`));
    else if (Array.isArray(term))
      for (const t of term)
        if (!validSlugs.has(t as string))
          errors.push(err('terminal[]', `unknown milestone "${t}"`));

    const opsRaw = dag['operations'];
    const allOpIds = new Set<string>();
    if (!Array.isArray(opsRaw) && !isObject(opsRaw))
      errors.push(err('operations', 'must be an array or object', opsRaw));
    else {
      const opsArray: unknown[] = Array.isArray(opsRaw)
        ? opsRaw
        : Object.values(opsRaw as Record<string, unknown>);
      for (const op of opsArray) {
        if (!isObject(op)) {
          errors.push(err('operations[]', 'must be an object', op));
          continue;
        }
        const opId = op['id'];
        if (!isString(opId)) {
          errors.push(err('operations[?]', 'missing/invalid id', opId));
          continue;
        }
        const id = opId as string;
        allOpIds.add(id);
        const mr = op['milestone'];
        if (!isString(mr))
          errors.push(
            err(`operations[${id}].milestone`, 'required string', mr)
          );
        else if (!validSlugs.has(mr))
          errors.push(
            err(`operations[${id}].milestone`, `unknown milestone "${mr}"`)
          );
        const type = op['type'];
        if (isString(type) && !VALID_OPERATION_TYPES.has(type))
          errors.push(err(`operations[${id}].type`, `invalid type`, type));
        const shape = op['shape'];
        if (isObject(shape)) {
          const kind = shape['kind'];
          if (
            kind !== null &&
            kind !== undefined &&
            isString(kind) &&
            !VALID_SHAPE_KINDS.has(kind)
          )
            errors.push(
              err(`operations[${id}].shape.kind`, `invalid shape kind`, kind)
            );
          const ops = shape['ops'];
          if (Array.isArray(ops) && isString(kind))
            for (let i = 0; i < (ops as unknown[]).length; i++) {
              const sop = (ops as unknown[])[i];
              if (!isObject(sop)) continue;
              const opType = sop['op'];
              if (
                isString(opType) &&
                !isValidOpForKind(kind, opType as ShapeOpType)
              )
                errors.push(
                  err(
                    `operations[${id}].shape.ops[${i}]`,
                    `op "${opType}" not valid for kind "${kind}"`
                  )
                );
            }
        }
        if (!Array.isArray(op['depends_on']))
          errors.push(
            err(
              `operations[${id}].depends_on`,
              'must be an array',
              op['depends_on']
            )
          );
      }
      for (const op of opsArray) {
        if (!isObject(op)) continue;
        const opId = op['id'];
        if (!isString(opId)) continue;
        const deps = op['depends_on'];
        if (!Array.isArray(deps)) continue;
        for (const dep of deps as unknown[])
          if (isString(dep) && !allOpIds.has(dep))
            errors.push(
              err(
                `operations[${opId}].depends_on`,
                `unknown operation "${dep}"`
              )
            );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateSnapshot(snapshot: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isObject(snapshot))
    return { valid: false, errors: [err('', 'root must be an object')] };
  for (const field of ['snapshot_at', 'description'])
    if (!isString(snapshot[field]))
      errors.push(err(field, 'required string field missing', snapshot[field]));
  if (!isString(snapshot['plan']))
    errors.push(err('plan', 'required string', snapshot['plan']));
  const milestonesRaw = snapshot['milestones'];
  if (!isObject(milestonesRaw))
    errors.push(err('milestones', 'must be an object', milestonesRaw));
  else {
    const milestoneKeys = Object.keys(milestonesRaw);
    const validSlugs = new Set(milestoneKeys);
    for (const slug of milestoneKeys) {
      const m = milestonesRaw[slug];
      if (!isObject(m)) {
        errors.push(err(`milestones.${slug}`, 'must be an object', m));
        continue;
      }
      const eligible = m['eligible'],
        pending = m['pending'];
      if (eligible === true && pending !== null && pending !== undefined)
        errors.push(
          err(
            `milestones.${slug}`,
            'D-07 violation: eligible=true but pending not null'
          )
        );
      if (typeof eligible !== 'boolean')
        errors.push(
          err(`milestones.${slug}.eligible`, 'must be boolean', eligible)
        );
      const status = m['status'];
      if (
        !isString(status) ||
        !VALID_MILESTONE_STATUSES.has(status as MilestoneStatus)
      )
        errors.push(err(`milestones.${slug}.status`, 'invalid status', status));
      const wave = m['wave'];
      if (typeof wave !== 'number' || !Number.isInteger(wave) || wave < 0)
        errors.push(
          err(`milestones.${slug}.wave`, 'must be non-negative integer', wave)
        );
      const ki = m['ki_estimate'];
      if (ki !== null && ki !== undefined && typeof ki !== 'number')
        errors.push(
          err(`milestones.${slug}.ki_estimate`, 'must be number|null', ki)
        );
      for (const f of ['tokens_estimated', 'tokens_actual']) {
        const v = m[f];
        if (v !== null && v !== undefined && typeof v !== 'number')
          errors.push(err(`milestones.${slug}.${f}`, 'must be number|null', v));
      }
      if (!Array.isArray(m['artifacts']))
        errors.push(
          err(
            `milestones.${slug}.artifacts`,
            'must be an array',
            m['artifacts']
          )
        );
      if (typeof m['si_bytes'] !== 'number')
        errors.push(
          err(`milestones.${slug}.si_bytes`, 'must be a number', m['si_bytes'])
        );
    }
    const opsRaw = snapshot['operations'];
    if (!Array.isArray(opsRaw))
      errors.push(err('operations', 'must be an array', opsRaw));
    else
      for (const op of opsRaw as unknown[]) {
        if (!isObject(op)) continue;
        const opId = isString(op['id']) ? op['id'] : '?';
        const opMilestone = op['milestone'];
        if (isString(opMilestone) && !validSlugs.has(opMilestone))
          errors.push(
            err(
              `operations[${opId}].milestone`,
              `unknown milestone "${opMilestone}"`
            )
          );
        const opStatus = op['status'];
        if (
          !isString(opStatus) ||
          !VALID_OPERATION_STATUSES.has(opStatus as OperationStatus)
        )
          errors.push(
            err(
              `operations[${opId}].status`,
              'invalid operation status',
              opStatus
            )
          );
        if (!Array.isArray(op['dispatch_ids']))
          errors.push(
            err(
              `operations[${opId}].dispatch_ids`,
              'must be an array',
              op['dispatch_ids']
            )
          );
        if (typeof op['attempt_count'] !== 'number')
          errors.push(
            err(
              `operations[${opId}].attempt_count`,
              'must be a number',
              op['attempt_count']
            )
          );
        if (!Array.isArray(op['blast_radius']))
          errors.push(
            err(
              `operations[${opId}].blast_radius`,
              'must be an array',
              op['blast_radius']
            )
          );
      }
    const oqs = snapshot['open_questions'];
    if (!Array.isArray(oqs))
      errors.push(err('open_questions', 'must be an array', oqs));
    else
      for (const oq of oqs as unknown[]) {
        if (!isObject(oq)) continue;
        const blocking = oq['blocking'];
        if (!isString(blocking) || !validSlugs.has(blocking))
          errors.push(
            err('open_questions', `unknown blocking milestone "${blocking}"`)
          );
        if (typeof oq['surfaced'] !== 'boolean')
          errors.push(
            err(
              `open_questions[${oq['id']}]`,
              'surfaced must be boolean',
              oq['surfaced']
            )
          );
        if (typeof oq['answered'] !== 'boolean')
          errors.push(
            err(
              `open_questions[${oq['id']}]`,
              'answered must be boolean',
              oq['answered']
            )
          );
      }
    const units = snapshot['dispatch_units'];
    if (units !== undefined) {
      if (!Array.isArray(units))
        errors.push(
          err('dispatch_units', 'must be an array if present', units)
        );
      else
        for (const unit of units as unknown[]) {
          if (!isObject(unit)) continue;
          const fits = unit['fits_context_window'];
          if (typeof fits !== 'boolean')
            errors.push(
              err(
                `dispatch_units[${unit['id']}]`,
                'fits_context_window must be boolean',
                fits
              )
            );
          const ms = unit['milestones'];
          if (Array.isArray(ms))
            for (const m of ms)
              if (isString(m) && !validSlugs.has(m))
                errors.push(
                  err(
                    `dispatch_units[${unit['id']}].milestones`,
                    `unknown milestone "${m}"`
                  )
                );
        }
    }
    if (!isObject(snapshot['pairwise_overlap']))
      errors.push(
        err(
          'pairwise_overlap',
          'must be an object',
          snapshot['pairwise_overlap']
        )
      );
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidDagJson(dag: unknown): asserts dag is DagJson {
  const r = validateDagJson(dag);
  if (!r.valid)
    throw new Error(
      `DagJson validation failed:\n${r.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n')}`
    );
}
export function assertValidSnapshot(s: unknown): asserts s is DagSnapshot {
  const r = validateSnapshot(s);
  if (!r.valid)
    throw new Error(
      `Snapshot validation failed:\n${r.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n')}`
    );
}
